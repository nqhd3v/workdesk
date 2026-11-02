// web.h — local web page on the joined network: http://workdesk.local (or the IP).
// Live env / battery / Wi-Fi status and the user settings. Login: one-time code shown on the screen.
#pragma once
#include <Arduino.h>

struct web_live_t {
    float temp_c, hum_pct, pressure_hpa; // NAN = no sensor
    uint32_t gas_ohm;
    int iaq, iaq_acc;                    // iaq -1 = none; acc 0 warm-up .. 3 calibrated
    float co2_eq;                        // ppm, NAN = none
    float lux;                           // NAN = no sensor
    int batt_mv, batt_pct;               // batt_pct -1 = unknown (e.g. on USB)
    const char *power;                   // "usb" / "battery" / "unknown"
    bool screen_on;
};

void web_begin(const char *fw_version);
void web_set_live(const web_live_t &live);

// Login code: exists only from web_code_new() until it expires (1 min), is used or is cleared.
void web_code_new();
void web_code_clear();
const char *web_code();
int web_code_left(); // seconds, 0 = no code

void web_loop(); // call often from loop(); runs only while connected (not in the setup portal)
