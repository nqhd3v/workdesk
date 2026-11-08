/*
 * workdesk (DeskEnv) — desk gadget firmware for Waveshare ESP32-S3-AMOLED-1.91
 *
 * What it does now:
 *   - Draws the home screen (clock, Claude / Copilot tiles, env column).
 *   - Clock starts from the time this sketch was compiled (no Wi-Fi yet -> "NO SYNC").
 *   - Optional sensors on I2C (SDA=IO40, SCL=IO39), found while running (env.cpp):
 *     BME680 through Bosch BSEC2 for temp, humidity, IAQ; BH1750 for light.
 *     "--" when not found; IAQ shows WARM-UP for the first ~5 min after boot.
 *   - microSD size, battery % from the onboard divider on GPIO1.
 *   - Wi-Fi: joins the saved network and syncs NTP. No saved network (or BOOT held 5 s)
 *     -> setup screen + soft AP portal (net.cpp). OTA (ArduinoOTA) while connected.
 *   - Backend (api.cpp, Workdesk): POST readings + GET Claude / Copilot usage and events each minute,
 *     from boot. A tile appears once its tool was received, grey when stale; none -> big clock.
 *   - BOOT short press: HOME <-> web login code (back home when the code expires or is used).
 *     With a new firmware downloaded, the press on HOME installs it instead.
 *   - Local web page (web.cpp) at http://workdesk.local: live data + settings (settings.cpp):
 *     brightness, NORMAL / SAVE BATTERY, night screen-off (BOOT wakes it 30 s), temp offset,
 *     meeting reminder time.
 *   - Meeting reminder: N min (settings, default 5, 0 = off) before a meeting from the backend's
 *     events, a page with the title, time range and an mm:ss countdown, then TIME'S UP for 60 s.
 *     It lights the screen during night screen-off. BOOT dismisses it.
 *
 * Board settings (Arduino IDE, esp32 core >= 3.3.0):
 *   Board ESP32S3 Dev Module · USB CDC On Boot: Enabled · Flash Mode QIO 80MHz
 *   Flash Size 16MB · Partition "16M Flash (3MB APP/9.9MB FATFS)" · PSRAM: OPI PSRAM
 *
 * Libraries: lvgl 8.4.0 + lv_conf.h from Waveshare's 01_Arduino_Libraries/lvgl8 (LV_USE_QRCODE 1),
 *            bsec2 (Bosch, + BME68x Sensor library), ArduinoJson 7.
 *
 * Display init is adapted from Waveshare's 03_LVGL_V8_Test example.
 */
#include <Arduino.h>
#include <Wire.h>
#include <SD_MMC.h>
#include <WiFi.h>
#include <time.h>
#include <sys/time.h>
#include <math.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "driver/spi_master.h"
#include "esp_timer.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "lvgl.h"
#include "esp_lcd_sh8601.h"
#include "ui.h"
#include "net.h"
#include "api.h"
#include "settings.h"
#include "web.h"
#include "fwupdate.h"
#include "env.h"
#include "logq.h"

#define FW_VERSION "0.9.7"

// ---- pins (from Waveshare examples) ----------------------------------------
#define PIN_LCD_CS    6
#define PIN_LCD_PCLK  47
#define PIN_LCD_D0    18
#define PIN_LCD_D1    7
#define PIN_LCD_D2    48
#define PIN_LCD_D3    5
#define PIN_LCD_RST   17
#define PIN_I2C_SDA   40   // shared with onboard QMI8658 IMU (and touch IC on touch boards)
#define PIN_I2C_SCL   39
#define PIN_SD_CLK    9
#define PIN_SD_CMD    42
#define PIN_SD_D0     8
#define PIN_BAT_ADC   1    // battery voltage through a 1:2 divider
#define PIN_BOOT      0    // BOOT button, active low. Press = login code, hold 5 s = Wi-Fi setup
// The board cannot sense USB power (no VBUS -> GPIO on the schematic). Optional mod: 100k/100k
// divider from header VBUS (H2 pin 1) to GND, middle to a free ADC pin, set that pin here.
#define PIN_VBUS_SENSE -1  // e.g. 2; -1 = not fitted
#define WAKE_MS         30000  // BOOT during night screen-off: screen on this long
#define CODE_MIN_BRIGHTNESS 50 // % on the login code page: it has to be readable, whatever the settings
#define MEET_HOLD_S     60     // meeting reminder: TIME'S UP stays this long after the start

#define LCD_H_RES 536
#define LCD_V_RES 240
#define LVGL_BUF_LINES (LCD_V_RES / 4)
#define LVGL_TICK_MS 2

static SemaphoreHandle_t lvgl_mux;
static int sd_gb = -1;

// ---- panel init commands (Waveshare) ---------------------------------------
static const sh8601_lcd_init_cmd_t lcd_init_cmds[] = {
  {0x11, (uint8_t[]){0x00}, 0, 120},
  {0x36, (uint8_t[]){0x30}, 1, 0},  // MADCTL: landscape, 180° (0xF0 = header pins on the other side)
  {0x3A, (uint8_t[]){0x55}, 1, 0},  // RGB565
  {0x2A, (uint8_t[]){0x00, 0x00, 0x02, 0x17}, 4, 0},
  {0x2B, (uint8_t[]){0x00, 0x00, 0x00, 0xEF}, 4, 0},
  {0x51, (uint8_t[]){0x00}, 1, 10},  // brightness 0: panel RAM is random after reset
  {0x29, (uint8_t[]){0x00}, 0, 10},
  // brightness goes up in panel_brightness() once the first black frame is on the panel
};
static esp_lcd_panel_io_handle_t panel_io;

static void panel_brightness(uint8_t level) {  // 0x00..0xFF
  int cmd = (0x02 << 24) | (0x51 << 8);         // QSPI write-command framing (see esp_lcd_sh8601.c tx_param)
  esp_lcd_panel_io_tx_param(panel_io, cmd, &level, 1);
}

// ---- LVGL glue -------------------------------------------------------------
static bool on_flush_done(esp_lcd_panel_io_handle_t, esp_lcd_panel_io_event_data_t *, void *ctx) {
  lv_disp_flush_ready((lv_disp_drv_t *)ctx);
  return false;
}

static void lvgl_flush(lv_disp_drv_t *drv, const lv_area_t *a, lv_color_t *px) {
  esp_lcd_panel_handle_t panel = (esp_lcd_panel_handle_t)drv->user_data;
  esp_lcd_panel_draw_bitmap(panel, a->x1, a->y1, a->x2 + 1, a->y2 + 1, px);
}

// The panel needs even start / odd end coordinates.
static void lvgl_rounder(lv_disp_drv_t *, lv_area_t *a) {
  a->x1 = (a->x1 >> 1) << 1;
  a->y1 = (a->y1 >> 1) << 1;
  a->x2 = ((a->x2 >> 1) << 1) + 1;
  a->y2 = ((a->y2 >> 1) << 1) + 1;
}

static void lvgl_tick(void *) { lv_tick_inc(LVGL_TICK_MS); }

static bool lvgl_lock(int timeout_ms = -1) {
  TickType_t t = timeout_ms < 0 ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
  return xSemaphoreTake(lvgl_mux, t) == pdTRUE;
}
static void lvgl_unlock() { xSemaphoreGive(lvgl_mux); }

static void lvgl_task(void *) {
  for (;;) {
    uint32_t wait = 5;
    if (lvgl_lock()) {
      wait = lv_timer_handler();
      lvgl_unlock();
    }
    if (wait > 500) wait = 500;
    if (wait < 1) wait = 1;
    vTaskDelay(pdMS_TO_TICKS(wait));
  }
}

static void display_init() {
  static lv_disp_draw_buf_t draw_buf;
  static lv_disp_drv_t disp_drv;

  const spi_bus_config_t bus = SH8601_PANEL_BUS_QSPI_CONFIG(
      PIN_LCD_PCLK, PIN_LCD_D0, PIN_LCD_D1, PIN_LCD_D2, PIN_LCD_D3, LCD_H_RES * LCD_V_RES * 2);
  ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO));

  esp_lcd_panel_io_handle_t io = NULL;
  const esp_lcd_panel_io_spi_config_t io_cfg = SH8601_PANEL_IO_QSPI_CONFIG(PIN_LCD_CS, on_flush_done, &disp_drv);
  sh8601_vendor_config_t vendor = {
    .init_cmds = lcd_init_cmds,
    .init_cmds_size = sizeof(lcd_init_cmds) / sizeof(lcd_init_cmds[0]),
    .flags = { .use_qspi_interface = 1 },
  };
  ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI2_HOST, &io_cfg, &io));
  panel_io = io;

  esp_lcd_panel_handle_t panel = NULL;
  esp_lcd_panel_dev_config_t panel_cfg = {};
  panel_cfg.reset_gpio_num = PIN_LCD_RST;
  panel_cfg.rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB;
  panel_cfg.bits_per_pixel = 16;
  panel_cfg.vendor_config = &vendor;
  ESP_ERROR_CHECK(esp_lcd_new_panel_sh8601(io, &panel_cfg, &panel));
  ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
  ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
  ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));

  lv_init();
  size_t px = LCD_H_RES * LVGL_BUF_LINES;
  lv_color_t *b1 = (lv_color_t *)heap_caps_malloc(px * sizeof(lv_color_t), MALLOC_CAP_DMA);
  lv_color_t *b2 = (lv_color_t *)heap_caps_malloc(px * sizeof(lv_color_t), MALLOC_CAP_DMA);
  assert(b1 && b2);
  lv_disp_draw_buf_init(&draw_buf, b1, b2, px);

  lv_disp_drv_init(&disp_drv);
  disp_drv.hor_res = LCD_H_RES;
  disp_drv.ver_res = LCD_V_RES;
  disp_drv.flush_cb = lvgl_flush;
  disp_drv.rounder_cb = lvgl_rounder;
  disp_drv.draw_buf = &draw_buf;
  disp_drv.user_data = panel;
  lv_disp_drv_register(&disp_drv);

  const esp_timer_create_args_t tick_args = { .callback = &lvgl_tick, .name = "lvgl_tick" };
  esp_timer_handle_t tick = NULL;
  ESP_ERROR_CHECK(esp_timer_create(&tick_args, &tick));
  ESP_ERROR_CHECK(esp_timer_start_periodic(tick, LVGL_TICK_MS * 1000));

  lvgl_mux = xSemaphoreCreateMutex();
  xTaskCreatePinnedToCore(lvgl_task, "lvgl", 6 * 1024, NULL, 2, NULL, 1);
}

// ---- clock: no time until NTP (the screen shows --:--) ------------------------
static void clock_init() {
  setenv("TZ", TZ_INFO, 1);
  tzset();
}

// ---- sensors ----------------------------------------------------------------
static void i2c_scan() {
  Serial.println("I2C scan (SDA=40, SCL=39):");
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) Serial.printf("  found 0x%02X\n", a);
  }
}

static int battery_pct(int mv) {
  // rough single-cell LiPo curve (resting voltage)
  static const int v[] = {3300, 3500, 3600, 3700, 3750, 3800, 3850, 3900, 4000, 4100, 4200};
  if (mv <= v[0]) return 0;
  for (int i = 1; i < 11; i++)
    if (mv < v[i]) return (i - 1) * 10 + (mv - v[i - 1]) * 10 / (v[i] - v[i - 1]);
  return 100;
}

// ---- power -------------------------------------------------------------------
// USB is known only with the VBUS divider mod, or when a computer is talking USB to us.
static ui_power_t power_source() {
#if PIN_VBUS_SENSE >= 0
  return analogReadMilliVolts(PIN_VBUS_SENSE) * 2 > 4000 ? UI_PWR_USB : UI_PWR_BATTERY;
#else
  return HWCDC::isPlugged() ? UI_PWR_USB : UI_PWR_UNKNOWN;
#endif
}

static const char *power_name(ui_power_t p) {
  return p == UI_PWR_USB ? "usb" : p == UI_PWR_BATTERY ? "battery" : "unknown";
}

// ---- pages -----------------------------------------------------------------------
static ui_page_t page = UI_PAGE_HOME;
static bool conn_shown = false, conn_skip = false;  // boot connecting screen; BOOT skips it
static bool screen_off = false;                      // night screen-off active
static uint32_t wake_at = 0;                         // BOOT pressed while off
static bool ota_active = false;                      // update / reboot overlay up: keep the screen lit
static uint32_t ota_err_at = 0;                      // failed update shown since (0 = not shown)
static int bright_sent = -1;                         // last level sent to the panel
static time_t meet_start = 0, meet_dismissed = 0;    // reminder on screen / dismissed with BOOT (meeting start)

// A code exists only while its page is up, so nobody can log in without seeing the screen.
static void toggle_code_page() {
  if (page == UI_PAGE_HOME) { web_code_new(); page = UI_PAGE_CODE; }
  else { web_code_clear(); page = UI_PAGE_HOME; }
}

// BOOT button: short press = login code (setup screen: cancel, connecting screen: skip),
// hold 5 s = Wi-Fi setup.
static void button_loop() {
  static uint32_t down_at = 0;
  static bool fired = false;
  bool down = digitalRead(PIN_BOOT) == LOW;
  uint32_t now = millis();
  if (down && !down_at) { down_at = now ? now : 1; fired = false; }
  if (down && !fired && now - down_at > 5000) {
    fired = true;
    if (net_state() != NET_PORTAL) net_start_portal();
  }
  if (!down && down_at) {
    if (!fired && now - down_at > 50) {
      if (screen_off) wake_at = now ? now : 1;  // first press only wakes the screen
      else if (net_state() == NET_PORTAL) { if (net_has_creds()) net_stop_portal(); }
      else if (conn_shown) conn_skip = true;
      else if (page == UI_PAGE_MEETING) { meet_dismissed = meet_start; page = UI_PAGE_HOME; }
      else if (page == UI_PAGE_HOME && fwupdate_install()) {}  // waiting update goes first, see the status bar
      else toggle_code_page();
    }
    down_at = 0;
  }
}

// OTA progress (called inside net_loop while an update streams in; loop() is blocked meanwhile,
// the LVGL task keeps the spinner turning). Success -> net.cpp schedules the reboot warning.
static void on_ota(int pct) {
  if (!lvgl_lock(100)) return;
  if (!ota_active) {  // first callback: light the screen even during night screen-off
    ota_active = true;
    if (bright_sent != brightness_level()) { bright_sent = brightness_level(); panel_brightness(bright_sent); }
  }
  if (pct < 0) { ui_ota_error(); ota_err_at = millis() | 1; }
  else { ui_ota(pct); ota_err_at = 0; }
  lvgl_unlock();
}

// Reboot countdown (OTA done, MAC change) and hiding the failed-update message.
static void reboot_overlay_loop() {
  int left = net_reboot_in();
  if (left < 0 && !ota_err_at) return;
  if (!lvgl_lock(50)) return;
  if (left >= 0) {
    if (!ota_active) { ota_active = true; bright_sent = brightness_level(); panel_brightness(bright_sent); }
    ui_reboot(net_reboot_reason(), left, REBOOT_WARN_MS / 1000);
  } else if (millis() - ota_err_at > 5000) {
    ui_ota(-1);
    ota_err_at = 0;
    ota_active = false;
  }
  lvgl_unlock();
}

// ---- meeting reminder ------------------------------------------------------------
// The first meeting that starts within the reminder time (settings), or started less than
// MEET_HOLD_S ago, unless BOOT dismissed it. -1 = none.
static int meeting_due(const api_data_t &api, time_t now) {
  int lead = settings().remind_min * 60;
  if (!lead) return -1;
  for (int i = 0; i < api.n_meetings; i++) {
    const api_meeting_t &m = api.meetings[i];
    if (m.start == meet_dismissed || now - m.start >= MEET_HOLD_S) continue;
    if (m.start - now <= lead) return i;
    break;  // sorted by start: the rest are later
  }
  return -1;
}

// ---- display: brightness, power mode, night screen-off ----------------------------
static bool in_night(const struct tm &lt) {
  const settings_t &s = settings();
  if (!s.night_off || s.night_start == s.night_end) return false;
  int m = lt.tm_hour * 60 + lt.tm_min;
  return s.night_start < s.night_end ? (m >= s.night_start && m < s.night_end)
                                     : (m >= s.night_start || m < s.night_end);  // across midnight
}

// Call with the LVGL lock held (same SPI device as the LVGL flush).
static int brightness_level() {
  const settings_t &s = settings();
  int pct = s.brightness;
  if (s.mode == MODE_SAVE_BATTERY && pct > SAVE_BATTERY_MAX_BRIGHTNESS) pct = SAVE_BATTERY_MAX_BRIGHTNESS;
  if (page == UI_PAGE_CODE && pct < CODE_MIN_BRIGHTNESS) pct = CODE_MIN_BRIGHTNESS;
  return (pct * 255 + 50) / 100;
}

static void apply_brightness(bool synced, const struct tm &lt) {
  bool woken = wake_at && millis() - wake_at < WAKE_MS;
  if (!woken) wake_at = 0;
  screen_off = synced && in_night(lt) && !woken && net_state() != NET_PORTAL && !ota_active && page != UI_PAGE_CODE && page != UI_PAGE_MEETING;
  int level = screen_off ? 0 : brightness_level();
  if (level != bright_sent) {
    panel_brightness(level);
    bright_sent = level;
  }
}

static void apply_power_mode() {
  static uint32_t seen = 0;
  static bool was_on = false;
  bool on = net_state() == NET_CONNECTED;
  if (seen == settings_rev() && on == was_on) return;
  seen = settings_rev();
  was_on = on;
  if (on) WiFi.setSleep(settings().mode == MODE_SAVE_BATTERY ? WIFI_PS_MAX_MODEM : WIFI_PS_MIN_MODEM);
}

static ui_wifi_t wifi_ui_state() {
  switch (net_state()) {
    case NET_CONNECTING: return net_booting() ? UI_WIFI_CONNECTING : UI_WIFI_OFF;  // dropped: off while rescanning
    case NET_CONNECTED:  return UI_WIFI_ON;
    case NET_PORTAL:     return UI_WIFI_AP;
    default:             return UI_WIFI_OFF;
  }
}

// ---- Arduino ----------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\nworkdesk boot " FW_VERSION);
  pinMode(PIN_BOOT, INPUT_PULLUP);

  clock_init();
  display_init();  // panel on at brightness 0

  if (lvgl_lock()) {
    ui_init();
    ui_set_tiles(false, false);  // until the API says otherwise
    ui_splash();                 // logo fades in / out, then home
    lv_refr_now(NULL);           // first frame: still black (logo at opacity 0)
    lvgl_unlock();
  }
  delay(20);                     // let the last DMA flush finish
  settings_begin();
  panel_brightness((settings().brightness * 255 + 50) / 100);  // no white / garbage flash at boot

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  i2c_scan();
  env_begin();

  SD_MMC.setPins(PIN_SD_CLK, PIN_SD_CMD, PIN_SD_D0);
  if (SD_MMC.begin("/sdcard", true)) {  // 1-bit mode
    sd_gb = (int)lround(SD_MMC.cardSize() / 1e9);
    Serial.printf("SD card: %d GB\n", sd_gb);
  } else {
    Serial.println("No SD card");
  }
  logq_begin(sd_gb >= 0);

  net_on_ota(on_ota);
  net_begin();
  api_begin(FW_VERSION);
  web_begin(FW_VERSION);
  fwupdate_begin(FW_VERSION);
}

void loop() {
  static uint32_t last_status = 0, last_ui = 0, last_sample = 0, setup_rev = 0;
  static env_t env = { NAN, NAN, NAN, 0, -1, 0, NAN, NAN, NAN };
  static int batt = -1, batt_mv = 0;
  static ui_power_t pwr = UI_PWR_UNKNOWN;
  static bool synced = false, status_dirty = true;
  static ui_page_t shown = UI_PAGE_HOME;
  static api_data_t api;
  static uint32_t api_seen = 0;

  net_loop();
  web_loop();
  button_loop();
  apply_power_mode();

  uint32_t now_ms = millis();
  if (now_ms - last_ui < 200) { delay(5); return; }
  last_ui = now_ms;
  reboot_overlay_loop();

  env_loop();
  env_get(&env);  // BSEC2 task (env.cpp) updates every 3 s

  if (now_ms - last_status > 5000 || last_status == 0) {
    last_status = now_ms;
    batt_mv = analogReadMilliVolts(PIN_BAT_ADC) * 2;
    batt = battery_pct(batt_mv);
    pwr = power_source();
    api_set_power(power_name(pwr), batt_mv, pwr == UI_PWR_USB ? -1 : batt);
    status_dirty = true;
  }
  if (net_time_synced() != synced) {
    synced = net_time_synced();
    status_dirty = true;
    if (synced) logq_time_synced(time(NULL));
  }

  time_t t = time(NULL);
  struct tm lt;
  localtime_r(&t, &lt);

  // Reading log (SD queue, logq.cpp) every 30 s, also before NTP: those get their time fixed from
  // the uptime once the clock syncs. The api task uploads the queue once a minute.
  if (now_ms - last_sample >= LOG_EVERY_MS || last_sample == 0) {
    last_sample = now_ms ? now_ms : 1;
    log_rec_t r = { synced ? (uint32_t)t : 0, logq_boot_id(), now_ms / 1000,
                    env.temp_c, env.hum_pct, env.pressure_hpa, env.gas_ohm,
                    (int16_t)env.iaq, (uint8_t)env.iaq_acc, env.co2_eq, env.voc_eq,
                    (int16_t)batt_mv, (int8_t)(pwr == UI_PWR_USB ? -1 : batt),
                    (uint8_t)(pwr == UI_PWR_USB ? 1 : pwr == UI_PWR_BATTERY ? 2 : 0), env.lux };
    logq_append(r);
    static int n_logged = 0;
    if (++n_logged % 2 == 0)  // serial: once a minute
      Serial.printf("log T=%.2f H=%.1f P=%.1f IAQ=%d(acc %d) CO2e=%.0f lux=%.0f batt=%dmV %s, queue %d\n", env.temp_c,
                    env.hum_pct, env.pressure_hpa, env.iaq, env.iaq_acc, env.co2_eq, env.lux, batt_mv, power_name(pwr),
                    logq_pending_files());
  }

  bool api_new = false;
  if (api_rev() != api_seen) { api_seen = api_rev(); api_get(&api); api_new = true; }
  // A usage tile appears once its tool was received; later it turns grey (last values kept) when
  // the tool is missing from the latest response, its reading is old, or the GETs keep failing.
  bool feed_ok = api.valid && t - api.fetched_at < API_GET_STALE_S;
  auto stale = [&](const api_usage_t &u) { return !feed_ok || !u.present || t - u.measured_at > API_STALE_S; };
  bool stale_claude = stale(api.claude), stale_copilot = stale(api.copilot);
  // No running Claude session (resets_at null or passed): "--" in grey instead of 0 %.
  bool claude_idle = synced && (!api.claude.session_reset || api.claude.session_reset <= t);

  int meet = synced ? meeting_due(api, t) : -1;
  if (meet >= 0 && page == UI_PAGE_HOME) page = UI_PAGE_MEETING;  // the code page isn't interrupted
  if (page == UI_PAGE_MEETING && meet < 0) page = UI_PAGE_HOME;
  meet_start = meet >= 0 ? api.meetings[meet].start : 0;

  if (page == UI_PAGE_CODE && !web_code_left()) page = UI_PAGE_HOME;

  if (lvgl_lock(50)) {
    // Which screen: logo > connecting (boot, or a join started from the phone) > setup > pages
    enum { V_SPLASH, V_CONN, V_SETUP, V_PAGE };
    static int view = V_SPLASH;
    static bool setup_cancel = false;
    bool portal = net_state() == NET_PORTAL;
    int want = ui_splash_active()                ? V_SPLASH
             : portal && net_portal_busy()       ? V_CONN
             : portal                            ? V_SETUP
             : net_booting() && !conn_skip       ? V_CONN
             : V_PAGE;

    if (want == V_CONN) {
      ui_connecting(portal ? net_portal_msg() : net_status());
    } else if (want == V_SETUP) {
      String mac = net_mac() + (net_mac_custom() ? " *" : "");
      if (view != V_SETUP || setup_cancel != net_has_creds()) {  // rebuild when the saved list empties / fills
        setup_cancel = net_has_creds();
        ui_show_setup(net_ap_ssid(), net_ap_pass(), net_portal_url(), mac.c_str(), setup_cancel);
        setup_rev = 0;
      }
      if (setup_rev != net_portal_rev()) {
        setup_rev = net_portal_rev();
        ui_setup_msg(net_portal_msg(), net_portal_msg_error());
        ui_setup_mac(mac.c_str());
      }
    } else if (want == V_PAGE && (view != V_PAGE || shown != page)) {
      ui_show_page(page);
      shown = page;
    }
    view = want;
    conn_shown = view == V_CONN && !portal;  // BOOT skips only the boot connecting screen

    // home
    if (synced) ui_set_time(lt.tm_hour, lt.tm_min, lt.tm_sec, lt.tm_wday, lt.tm_mday, lt.tm_mon + 1);
    else ui_set_time(-1, 0, 0, -1, 0, 0);  // --:-- until NTP
    ui_set_env(env.temp_c, env.hum_pct, env.iaq, env.iaq_acc, env.lux);
    ui_set_wifi(wifi_ui_state(), net_rssi());
    {
      static int dot = -1;
      api_sync_t st = api_sync_state();
      ui_sync_t d = net_state() != NET_CONNECTED ? UI_SYNC_ERROR
                  : st == API_SYNC_BUSY          ? UI_SYNC_BUSY
                  : st == API_SYNC_OK            ? UI_SYNC_OK
                  : st == API_SYNC_FAILED        ? UI_SYNC_ERROR
                  : UI_SYNC_IDLE;
      if (d != dot) { dot = d; ui_set_sync(d); }
    }
    static int stale_shown = -1;
    int stale_key = stale_claude | stale_copilot << 1 | claude_idle << 2;
    if (api_new || stale_key != stale_shown) {  // values first, so a tile that appears is already filled in
      stale_shown = stale_key;
      ui_set_claude(api.claude.seen && !claude_idle ? api.claude.session_pct : -1, api.claude.seen ? api.claude.week_pct : -1, stale_claude);
      ui_set_copilot(api.copilot.seen ? api.copilot.month_pct : -1, stale_copilot);
    }
    ui_set_tiles(api.claude.seen, api.copilot.seen);
    if (status_dirty) {
      ui_set_status(sd_gb, batt, pwr);
      status_dirty = false;
    }

    if (view == V_PAGE && page == UI_PAGE_CODE) ui_set_code(web_code(), web_code_left());
    if (view == V_PAGE && page == UI_PAGE_MEETING) {
      const api_meeting_t &m = api.meetings[meet];
      struct tm a, b;
      localtime_r(&m.start, &a);
      localtime_r(&m.end, &b);
      char range[16];
      snprintf(range, sizeof range, "%02d:%02d-%02d:%02d", a.tm_hour, a.tm_min, b.tm_hour, b.tm_min);
      ui_set_meeting(m.title, range, (int)(m.start - t));
    }
    ui_set_update(fwupdate_ready());
    apply_brightness(synced, lt);
    lvgl_unlock();
  }

  web_live_t wl = { env.temp_c, env.hum_pct, env.pressure_hpa, env.gas_ohm, env.iaq, env.iaq_acc, env.co2_eq, env.lux, batt_mv, pwr == UI_PWR_USB ? -1 : batt, power_name(pwr), !screen_off };
  web_set_live(wl);
}
