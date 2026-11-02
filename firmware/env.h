// env.h — optional sensors on the fixed I2C pins, detected while running: BME680 through Bosch BSEC2
// (temp, humidity, IAQ, CO2 / VOC equivalents) and BH1750 (light), in their own task.
#pragma once
#include <Arduino.h>

struct env_t {
    float temp_c, hum_pct, pressure_hpa; // heat-compensated temp / humidity incl. the temp offset; NAN = none
    uint32_t gas_ohm;                    // 0 = none
    int iaq;                             // 0..500, -1 = no value yet
    int iaq_acc;                         // 0 warming up (IAQ not meaningful), 1 low, 2 medium, 3 calibrated
    float co2_eq, voc_eq;                // ppm estimates, NAN = none
    float lux;                           // NAN = no BH1750
};

void env_begin();          // once in setup() after Wire.begin()
void env_get(env_t *out);  // thread-safe copy of the latest outputs
void env_loop();           // call from loop(): writes the BSEC calibration state to NVS when due
