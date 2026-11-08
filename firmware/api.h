// api.h — backend sync: POST env readings, GET what to render. Runs in its own task.
// Contract: workdesk/docs/api.md (POST /api/module, GET /api/module/config).
#pragma once
#include <Arduino.h>
#include <time.h>

// Base URL + key come from NVS (net_api_url / net_api_token), see api.cpp
#define API_MODULE_PATH "/api/module"   // POST readings (Workdesk ingest API)
#define API_GET_PATH    "/api/module/config" // GET usage states + events (rate limit 10/min/key)
#define API_STALE_S     (60 * 60)  // usage measured longer ago than this is shown grey
#define API_GET_STALE_S (5 * 60)   // no successful GET for this long: everything shown grey
#define API_MAX_MEET    8

struct api_meeting_t {
    char title[96];   // UTF-8
    char location[64]; // "" = none
    time_t start, end;
};

// Latest usage of one tool (claude / copilot). Values are kept when a later response lacks the
// tool, so the screen can show them grey instead of dropping the tile.
struct api_usage_t {
    bool seen;        // received at least once since boot (tile exists)
    bool present;     // in the latest successful response
    int session_pct, week_pct, month_pct; // -1 = the tool has no such window
    time_t session_reset; // 0 = no active session
    time_t measured_at;
};

struct api_data_t {
    bool valid;       // a GET succeeded at least once
    time_t fetched_at;
    api_usage_t claude, copilot;
    int n_meetings;   // upcoming only, sorted by start
    api_meeting_t meetings[API_MAX_MEET];
};

void api_begin(const char *fw_version);
void api_set_power(const char *source, int batt_mv, int batt_pct /* -1 = unknown */);
void api_get(api_data_t *out);     // thread-safe copy
uint32_t api_rev();                // changes after every successful GET

// Upload state for the header dot: BUSY while posting, OK for API_SYNC_OK_MS after a batch was
// accepted, FAILED when the last round failed (or no backend is set), IDLE otherwise.
#define API_SYNC_OK_MS 5000
typedef enum { API_SYNC_IDLE, API_SYNC_BUSY, API_SYNC_OK, API_SYNC_FAILED } api_sync_t;
api_sync_t api_sync_state();
void api_last(int *http_code, time_t *at, time_t *next_at); // for the system screen
