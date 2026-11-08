// ui.h — Desk Env home screen (LVGL 8.4, 536x240 landscape)
#pragma once
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

// Build the home screen on the active display. Call once, with the LVGL lock held.
void ui_init(void);

// All setters must be called with the LVGL lock held.
void ui_set_time(int hour, int min, int sec, int wday /*0=Sun*/, int mday, int mon /*1-12*/); // hour < 0 = "--:--"

// Pass NAN (from <math.h>) for any value that is not available yet -> shows "--".
void ui_set_env(float temp_c, float hum_pct, int iaq /* <0 = unknown */, int iaq_acc /* 0 = warm-up .. 3 */, float lux); // NAN temp / lux = sensor not there: hidden

// Usage tiles: border + big % = session, "WK" = week; -1 = "--" in grey with an empty border
// (also used for "no active session"); stale = last values in grey.
void ui_set_claude(int session_pct, int week_pct, bool stale);
void ui_set_copilot(int month_pct, bool stale);
// Which AI tiles are shown. None -> the clock grows to fill the left side.
void ui_set_tiles(bool claude, bool copilot);

// synced: clock came from NTP. sd_gb: -1 = no card. batt_pct: -1 = unknown.
// UI_PWR_USB replaces the battery gauge with a USB mark (the % is meaningless on USB).
typedef enum { UI_PWR_UNKNOWN, UI_PWR_BATTERY, UI_PWR_USB } ui_power_t;
void ui_set_status(int sd_gb, int batt_pct, ui_power_t power);
void ui_set_update(const char *version); // firmware waiting for BOOT, "" = none
// Header dot: grey idle, yellow uploading, green just uploaded, red offline / upload failing.
typedef enum { UI_SYNC_IDLE, UI_SYNC_BUSY, UI_SYNC_OK, UI_SYNC_ERROR } ui_sync_t;
void ui_set_sync(ui_sync_t s);

// Wi-Fi icon in the status bar. CONNECTING animates the arcs; ON shows the level and "-58dBm".
typedef enum { UI_WIFI_OFF, UI_WIFI_CONNECTING, UI_WIFI_ON, UI_WIFI_AP } ui_wifi_t;
void ui_set_wifi(ui_wifi_t state, int rssi_dbm);

// Wi-Fi setup screen: QR to join the soft AP (needs LV_USE_QRCODE 1), SSID / password, URL,
// device MAC and a status line. can_cancel shows the "BOOT = cancel" hint.
void ui_show_setup(const char *ap_ssid, const char *ap_pass, const char *url, const char *mac, bool can_cancel);
void ui_setup_msg(const char *msg, bool error);
void ui_setup_mac(const char *mac); // "aa:bb:..." plus " *" when custom

// Pages, switched with the BOOT button. Showing a page also leaves the setup screen.
// MEETING is shown by the reminder (not by BOOT): BOOT on it dismisses it.
typedef enum { UI_PAGE_HOME, UI_PAGE_CODE, UI_PAGE_MEETING, UI_PAGE_COUNT } ui_page_t;
void ui_show_page(ui_page_t page);

// Meeting reminder: title (UTF-8, 2 lines max), location ("" = hidden), start / end "14:00",
// secs until start: header "IN 4 MIN" / "IN 40 SEC", <= 0 = "TIME'S UP".
void ui_set_meeting(const char *title, const char *location, const char *start, const char *end, int secs);
void ui_set_code(const char *code, int secs_left); // web login code and its countdown

// Connecting screen (boot, while saved networks are tried). Updates the status line when shown.
// Showing a page or the setup screen removes it.
void ui_connecting(const char *status);

// Boot logo: fade in, hold, fade out, then the home screen (~2 s, runs in the LVGL task).
// While it runs, callers must not switch screens.
void ui_splash(void);
bool ui_splash_active(void);

// Overlay on top of every screen for updates and reboots.
void ui_ota(int pct);                                // 0..99 progress + spinner, 100 = done, -1 hides
void ui_ota_error(void);                             // "UPDATE FAILED" (hide with ui_ota(-1))
void ui_reboot(const char *why, int secs, int total); // "REBOOTING IN n", bar drains; secs < 0 hides

#ifdef __cplusplus
}
#endif
