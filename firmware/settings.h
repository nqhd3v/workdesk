// settings.h — user settings (local web page), kept in NVS namespace "cfg".
#pragma once
#include <Arduino.h>

enum power_mode_t { MODE_NORMAL = 0, MODE_SAVE_BATTERY = 1 };

struct settings_t {
    uint8_t brightness;    // 5..100 %
    uint8_t mode;          // power_mode_t
    float temp_offset;     // added to the BME680 temperature, -10..10 C
    bool night_off;        // screen off between night_start and night_end
    uint16_t night_start;  // minutes after midnight
    uint16_t night_end;
    uint8_t remind_min;    // meeting reminder this many minutes before the start, 0 = off
};

#define SAVE_BATTERY_MAX_BRIGHTNESS 30  // %
#define REMIND_MAX_MIN 60

void settings_begin();
const settings_t &settings();
void settings_set(const settings_t &s); // clamps, saves, bumps settings_rev()
uint32_t settings_rev();
const char *mode_name(uint8_t mode);
