// env.cpp — optional sensors in their own FreeRTOS task (SensorTask): BME680 through Bosch BSEC2 and
// BH1750. Both sit on the fixed I2C pins and are looked for every PROBE_MS, so either can be plugged
// in or removed while running; a sensor that isn't there leaves its fields empty.
//
// BSEC needs run() called on its exact schedule (LP mode: one forced measurement every 3 s) and
// blocks during the heater phase, so it lives here instead of loop(). The task owns the I2C bus
// after env_begin() (nothing else uses Wire at runtime; the QMI8658 IMU is not used yet).
//
// IAQ: BSEC reports accuracy 0 for the first ~5 min (warm-up), then calibrates against the
// cleanest / dirtiest air it sees over the calibration window (4 days with this config). The
// calibration state is saved to NVS ("bsec"/"state") once it reaches accuracy 3, then every 4 h,
// and loaded at boot, so a reboot doesn't start from scratch.
//
// RAM: the task stack (8 KB) lives in PSRAM to spare internal RAM (Wi-Fi needs it). A task with a
// PSRAM stack must not touch flash (cache is off during flash ops), so NVS is read in env_begin()
// and written from loop() via env_loop().
#include "env.h"
#include "settings.h"
#include <Wire.h>
#include <Preferences.h>
#include <bsec2.h>
#include <freertos/idf_additions.h>

// BME680, 3.3 V supply, LP (3 s), 4-day calibration window
static const uint8_t bsec_config[] = {
#include "config/bme680/bme680_iaq_33v_3s_4d/bsec_iaq.txt"
};

#define STATE_SAVE_MS (4UL * 3600 * 1000)
#define PROBE_MS      5000
#define LUX_MS        2000
#define TASK_STACK    8192  // setConfig / getState / setState each keep a 4 KB work buffer on the stack

static Bsec2 bsec;
static SemaphoreHandle_t mux;
static const env_t none = { NAN, NAN, NAN, 0, -1, 0, NAN, NAN, NAN };
static env_t cur = none;
static uint8_t addr = 0, bh_addr = 0; // 0 = not plugged in
static uint8_t st_boot[BSEC_MAX_STATE_BLOB_SIZE], st_out[BSEC_MAX_STATE_BLOB_SIZE];
static bool have_boot_state = false;
static volatile bool st_pending = false; // st_out ready for env_loop() to write

static void idle_us(uint32_t us, void *)
{
    if (us >= 2000) vTaskDelay(pdMS_TO_TICKS(us / 1000)); // heater wait: let other tasks run
    else delayMicroseconds(us);
}

static bool bsec_ok(const char *what)
{
    if (bsec.status < BSEC_OK) {
        Serial.printf("[env] %s: BSEC error %d\n", what, (int)bsec.status);
        return false;
    }
    if (bsec.status > BSEC_OK) Serial.printf("[env] %s: BSEC warning %d\n", what, (int)bsec.status);
    if (bsec.sensor.checkStatus() == BME68X_ERROR) {
        Serial.printf("[env] %s: BME68x error %s\n", what, bsec.sensor.statusString().c_str());
        return false;
    }
    return true;
}

static void state_load()
{
    if (!have_boot_state) { Serial.println("[env] no saved BSEC state, calibrating from scratch"); return; }
    if (bsec.setState(st_boot)) Serial.println("[env] BSEC state restored");
    else Serial.printf("[env] saved BSEC state rejected (%d), calibrating from scratch\n", (int)bsec.status);
}

static void state_save() // in the task: snapshot only, env_loop() writes it
{
    if (st_pending) return;
    if (!bsec.getState(st_out)) { Serial.printf("[env] getState failed (%d)\n", (int)bsec.status); return; }
    st_pending = true;
}

void env_loop()
{
    if (!st_pending) return;
    Preferences p;
    p.begin("bsec", false);
    p.putBytes("state", st_out, sizeof st_out);
    p.end();
    st_pending = false;
    Serial.println("[env] BSEC state saved");
}

static bool bsec_setup()
{
    bsecSensor list[] = {
        BSEC_OUTPUT_IAQ,
        BSEC_OUTPUT_CO2_EQUIVALENT,
        BSEC_OUTPUT_BREATH_VOC_EQUIVALENT,
        BSEC_OUTPUT_RAW_PRESSURE,
        BSEC_OUTPUT_RAW_GAS,
        BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_TEMPERATURE,
        BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_HUMIDITY,
    };
    // BSEC instance (3.2 KB) in PSRAM too; begin() only allocates one when none is set
    static uint8_t *mem = (uint8_t *)heap_caps_malloc(BSEC_INSTANCE_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (mem) bsec.allocateMemory(*reinterpret_cast<uint8_t(*)[BSEC_INSTANCE_SIZE]>(mem));
    if (!bsec.begin(addr, Wire, idle_us)) return bsec_ok("begin"), false;
    if (!bsec.setConfig(bsec_config)) return bsec_ok("setConfig"), false;
    state_load();
    if (!bsec.updateSubscription(list, ARRAY_LEN(list), BSEC_SAMPLE_RATE_LP)) return bsec_ok("subscribe"), false;
    Serial.printf("[env] BSEC %d.%d.%d.%d on BME680 0x%02X, LP 3 s\n", bsec.version.major, bsec.version.minor,
                  bsec.version.major_bugfix, bsec.version.minor_bugfix, addr);
    return true;
}

static bool bme680_at(uint8_t a)
{
    Wire.beginTransmission(a);
    Wire.write(0xD0); // chip id
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom(a, (uint8_t)1) != 1) return false;
    return Wire.read() == 0x61;
}

static void publish(const env_t &e)
{
    xSemaphoreTake(mux, portMAX_DELAY);
    cur = e;
    xSemaphoreGive(mux);
}

static void bme680_probe()
{
    if (addr) {
        if (bme680_at(addr)) return;
        Serial.printf("[env] BME680 0x%02X gone\n", addr);
        addr = 0;
        env_t e = none;
        e.lux = cur.lux;
        publish(e);
        return;
    }
    for (uint8_t a : { 0x77, 0x76 }) {
        if (!bme680_at(a)) continue;
        addr = a;
        if (!bsec_setup()) { Serial.println("[env] BSEC init failed, retrying"); addr = 0; }
        return;
    }
}

// Starts continuous high-resolution mode: 1 lx steps, a new value every 120 ms.
static bool bh1750_start(uint8_t a)
{
    Wire.beginTransmission(a);
    Wire.write(0x10);
    return Wire.endTransmission() == 0;
}

static void bh1750_probe()
{
    if (bh_addr) return; // bh1750_read() notices when it goes
    for (uint8_t a : { 0x23, 0x5C }) {
        if (!bh1750_start(a)) continue;
        bh_addr = a;
        Serial.printf("[env] BH1750 on 0x%02X\n", a);
        return;
    }
}

static void bh1750_read()
{
    env_t e = cur;
    if (Wire.requestFrom(bh_addr, (uint8_t)2) == 2) {
        uint16_t raw = Wire.read() << 8;
        raw |= Wire.read();
        e.lux = raw / 1.2f;
    } else {
        Serial.printf("[env] BH1750 0x%02X gone\n", bh_addr);
        bh_addr = 0;
        e.lux = NAN;
    }
    publish(e);
}

static void bme680_read(int64_t &last_ts, uint32_t &saved_at, bool &saved_once)
{
    // BSEC subtracts the "heat source" offset; the user setting is added (negative = reads high)
    bsec.setTemperatureOffset(-settings().temp_offset);
    if (!bsec.run()) bsec_ok("run");

    const bsecOutputs *o = bsec.getOutputs();
    if (!o || !o->nOutputs || o->output[0].time_stamp == last_ts) return;
    last_ts = o->output[0].time_stamp;
    env_t e = cur;
    for (uint8_t i = 0; i < o->nOutputs; i++) {
        const bsecData &d = o->output[i];
        switch (d.sensor_id) {
        case BSEC_OUTPUT_IAQ: e.iaq = (int)lroundf(d.signal); e.iaq_acc = d.accuracy; break;
        case BSEC_OUTPUT_CO2_EQUIVALENT: e.co2_eq = d.signal; break;
        case BSEC_OUTPUT_BREATH_VOC_EQUIVALENT: e.voc_eq = d.signal; break;
        case BSEC_OUTPUT_RAW_PRESSURE: e.pressure_hpa = d.signal; break; // already hPa
        case BSEC_OUTPUT_RAW_GAS: e.gas_ohm = (uint32_t)d.signal; break;
        case BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_TEMPERATURE: e.temp_c = d.signal; break;
        case BSEC_OUTPUT_SENSOR_HEAT_COMPENSATED_HUMIDITY: e.hum_pct = d.signal; break;
        }
    }
    publish(e);

    if (e.iaq_acc >= 3 && (!saved_once || millis() - saved_at > STATE_SAVE_MS)) {
        state_save();
        saved_once = true;
        saved_at = millis();
    }
}

static void env_task(void *)
{
    int64_t last_ts = 0;
    uint32_t saved_at = 0, probed_at = 0, lux_at = 0;
    bool saved_once = false, first = true;
    for (;;) {
        if (first || millis() - probed_at >= PROBE_MS) {
            first = false;
            probed_at = millis();
            bme680_probe();
            bh1750_probe();
        }
        if (addr) bme680_read(last_ts, saved_at, saved_once);
        if (bh_addr && millis() - lux_at >= LUX_MS) {
            lux_at = millis();
            bh1750_read();
        }
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

void env_begin()
{
    Preferences p;
    p.begin("bsec", true);
    have_boot_state = p.getBytes("state", st_boot, sizeof st_boot) == sizeof st_boot;
    p.end();
    mux = xSemaphoreCreateMutex();
    if (xTaskCreatePinnedToCoreWithCaps(env_task, "env", TASK_STACK, NULL, 1, NULL, 0,
                                        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT) != pdPASS) {
        Serial.println("[env] PSRAM task failed, using internal RAM");
        xTaskCreatePinnedToCore(env_task, "env", TASK_STACK, NULL, 1, NULL, 0);
    }
}

void env_get(env_t *out)
{
    if (!mux) { *out = cur; return; }
    xSemaphoreTake(mux, portMAX_DELAY);
    *out = cur;
    xSemaphoreGive(mux);
}
