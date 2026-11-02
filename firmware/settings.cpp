// settings.cpp — user settings in NVS. Only touched from the loop task (web handlers run there).
#include "settings.h"
#include <Preferences.h>

static Preferences prefs;
static settings_t cur;
static uint32_t rev = 1;

static void clamp(settings_t &s)
{
    s.brightness = constrain(s.brightness, 5, 100);
    if (s.mode > MODE_SAVE_BATTERY) s.mode = MODE_NORMAL;
    if (isnan(s.temp_offset)) s.temp_offset = 0;
    s.temp_offset = constrain(s.temp_offset, -10.0f, 10.0f);
    s.night_start %= 24 * 60;
    s.night_end %= 24 * 60;
}

void settings_begin()
{
    prefs.begin("cfg", false);
    cur.brightness = prefs.getUChar("bright", 100);
    cur.mode = prefs.getUChar("mode", MODE_NORMAL);
    cur.temp_offset = prefs.getFloat("t_off", 0);
    cur.night_off = prefs.getBool("night", false);
    cur.night_start = prefs.getUShort("n_start", 22 * 60);
    cur.night_end = prefs.getUShort("n_end", 7 * 60);
    clamp(cur);
}

const settings_t &settings() { return cur; }

void settings_set(const settings_t &s)
{
    cur = s;
    clamp(cur);
    prefs.putUChar("bright", cur.brightness);
    prefs.putUChar("mode", cur.mode);
    prefs.putFloat("t_off", cur.temp_offset);
    prefs.putBool("night", cur.night_off);
    prefs.putUShort("n_start", cur.night_start);
    prefs.putUShort("n_end", cur.night_end);
    rev++;
}

uint32_t settings_rev() { return rev; }

const char *mode_name(uint8_t mode) { return mode == MODE_SAVE_BATTERY ? "save_battery" : "normal"; }
