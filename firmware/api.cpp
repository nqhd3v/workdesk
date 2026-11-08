// api.cpp — backend sync task.
//
// Backend: Workdesk ingest API (docs: workdesk/docs/api.md). Base URL + module API key live in NVS
// (setup page or POST /api/backend on the local web page); nothing is sent until both are set.
//
// Schedule (once Wi-Fi is up and the clock is NTP-synced):
//   POST {url}/api/module: right away after boot, then every wall-clock minute. Readings come from
//     the log queue (logq.cpp, SD card), oldest batch first. Per the API's retry rule:
//       2xx            -> batch accepted (201; duplicates per (device.id, ts) are skipped), deleted
//       500 / network  -> retried twice within the minute (after 3 s, then 10 s), then next minute
//       400, 413, 422  -> the batch itself is bad and never will be accepted: logged and dropped
//       401, 403       -> key problem: batch kept, try again next minute
//     Up to POST_MAX_BATCHES batches per minute to catch up after an outage.
//   GET {url}/api/module/config: right after boot, then every minute after the POST: Claude /
//     Copilot usage + upcoming events. 429 -> wait Retry-After. A failed GET keeps the last data.
// Auth header: "x-workdesk-key: <key>".
#include "api.h"
#include "net.h"
#include "logq.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include "fwupdate.h"
#include <ArduinoJson.h>

// ESP-IDF's default root CA bundle, linked into the core's mbedtls (CONFIG_MBEDTLS_CERTIFICATE_BUNDLE_DEFAULT_FULL)
extern const uint8_t ca_bundle_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t ca_bundle_end[] asm("_binary_x509_crt_bundle_end");

#define DEVICE_NAME      "Workdesk"  // shown on Workdesk's Devices page
#define HTTP_TIMEOUT     10000
#define BATCH_MAX        360   // records per POST (one log batch file)
#define POST_MAX_BATCHES 6     // per minute while catching up
#define BODY_CAP         (BATCH_MAX * 240 + 1024)

static SemaphoreHandle_t mux;
static api_data_t data;
static uint32_t rev = 0;
static log_rec_t *batch;   // PSRAM
static char *body;         // PSRAM
static String pwr_source = "unknown";
static int pwr_mv = 0, pwr_pct = -1;
static const char *fw = "";
static int last_code = 0;
static volatile bool posting = false;     // a POST round is running
static volatile bool post_failed = false; // the last round ended with a failure
static volatile uint32_t ok_at = 0;       // millis() of the last accepted batch (0 = none)
static time_t last_at = 0, next_at = 0;

static void lock() { xSemaphoreTake(mux, portMAX_DELAY); }
static void unlock() { xSemaphoreGive(mux); }

static void set_defaults(api_data_t *d)
{
    memset(d, 0, sizeof *d);
}

static void add_headers(HTTPClient &http)
{
    http.addHeader("x-workdesk-key", net_api_token());
    http.addHeader("X-Device-Id", net_device_id());
    http.setTimeout(HTTP_TIMEOUT);
    http.setConnectTimeout(HTTP_TIMEOUT);
}

// ---- POST readings ----------------------------------------------------------
// Body built by hand into a PSRAM buffer: a full batch is ~70 KB of JSON, too much for internal RAM.
struct buf_t {
    char *p;
    size_t n;
    void add(const char *fmt, ...) __attribute__((format(printf, 2, 3)))
    {
        if (n >= BODY_CAP) return;
        va_list ap;
        va_start(ap, fmt);
        int w = vsnprintf(p + n, BODY_CAP - n, fmt, ap);
        va_end(ap);
        n = w < 0 ? n : min(n + (size_t)w, (size_t)BODY_CAP);
    }
    void f(const char *key, float v, int dec) // "key":v or null
    {
        if (isnan(v)) add(",\"%s\":null", key);
        else add(",\"%s\":%.*f", key, dec, v);
    }
};

static const char *power_name(uint8_t p) { return p == 1 ? "usb" : p == 2 ? "battery" : "unknown"; }

// Returns the HTTP code (<= 0 = no connection), or 200 when nothing in the batch is sendable.
static int post_batch(NetworkClient &client, const String &url, int n)
{
    uint32_t up = millis() / 1000;
    buf_t b = { body, 0 };
    lock();
    b.add("{\"v\":1,\"device\":{\"id\":\"%s\",\"name\":\"%s\",\"fw\":\"%s\",\"uptime_s\":%lu}", net_device_id().c_str(),
          DEVICE_NAME, fw, (unsigned long)up);
    b.add(",\"power\":{\"source\":\"%s\",\"batt_mv\":%d,\"batt_pct\":", pwr_source.c_str(), pwr_mv);
    if (pwr_pct >= 0) b.add("%d}", pwr_pct); else b.add("null}");
    unlock();
    b.add(",\"readings\":[");
    int sent = 0, dropped = 0;
    for (int i = 0; i < n; i++) {
        const log_rec_t &r = batch[i];
        uint32_t ts = logq_record_ts(r);      // written before NTP: boot start + uptime
        if (!ts) { dropped++; continue; } // a boot that never got the time: unusable
        b.add("%s{\"ts\":%lu", sent ? "," : "", (unsigned long)ts);
        b.f("temp_c", r.temp_c, 2);
        b.f("hum_pct", r.hum_pct, 1);
        b.f("pressure_hpa", r.pressure_hpa, 1);
        if (r.gas_ohm) b.add(",\"gas_ohm\":%lu", (unsigned long)r.gas_ohm); else b.add(",\"gas_ohm\":null");
        if (r.iaq >= 0) b.add(",\"iaq\":%d", r.iaq); else b.add(",\"iaq\":null");
        b.add(",\"iaq_acc\":%d", r.iaq_acc);
        b.f("co2_ppm", r.co2_eq, 0);
        b.f("voc_ppm", r.voc_eq, 2);
        b.f("lux", r.lux, 0);
        b.add(",\"batt_mv\":%d,\"batt_pct\":", r.batt_mv);
        if (r.batt_pct >= 0) b.add("%d", r.batt_pct); else b.add("null");
        b.add(",\"power\":\"%s\"}", power_name(r.power));
        sent++;
    }
    b.add("],\"wifi\":{\"ssid\":\"%s\",\"rssi\":%d,\"ip\":\"%s\"}}", WiFi.SSID().c_str(), WiFi.RSSI(),
          WiFi.localIP().toString().c_str());
    if (dropped) Serial.printf("[api] %d reading(s) without a time skipped\n", dropped);
    if (!sent) return 200;
    if (b.n >= BODY_CAP) { Serial.println("[api] POST body too big, batch skipped"); return 200; }

    HTTPClient http;
    if (!http.begin(client, url + API_MODULE_PATH)) return -1;
    add_headers(http);
    http.addHeader("Content-Type", "application/json");
    uint32_t t0 = millis();
    int code = http.POST((uint8_t *)body, b.n);
    String resp = code > 0 ? http.getString() : String();
    http.end();
    Serial.printf("[api] POST %d readings (%u B) -> %d (%u ms, internal heap %u B, largest %u B)\n", sent, (unsigned)b.n, code,
                  (unsigned)(millis() - t0), (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    if (code >= 200 && code < 300) {
        // {"received":n,"stored":n,"server_time":t}: warn when the clocks disagree (ts is validated)
        JsonDocument r;
        if (!deserializeJson(r, resp)) {
            long drift = (long)((r["server_time"] | 0L) - (long)time(nullptr));
            Serial.printf("[api] stored %d of %d\n", r["stored"] | -1, r["received"] | -1);
            if (r["server_time"].is<long>() && labs(drift) > 30) Serial.printf("[api] clock drift %ld s vs server\n", drift);
        }
    } else if (code > 0) {
        Serial.printf("[api] %s\n", resp.substring(0, 300).c_str()); // {"error":{"code","message","issues"}}
    } else {
        char tls_err[100] = "";
        if (url.startsWith("https://")) static_cast<NetworkClientSecure &>(client).lastError(tls_err, sizeof tls_err);
        Serial.printf("[api] %s%s%s (internal heap %u B, largest %u B)\n", HTTPClient::errorToString(code).c_str(),
                      tls_err[0] ? ", TLS: " : "", tls_err, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                      (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    }
    lock();
    last_code = code;
    unlock();
    return code;
}

// Send what the log queue holds, oldest first. Stops at the first batch that keeps failing.
static void post_queue_run(NetworkClient &client, const String &url);
static void post_queue(NetworkClient &client, const String &url)
{
    posting = true;
    post_failed = false;
    post_queue_run(client, url);
    posting = false;
}

static void post_queue_run(NetworkClient &client, const String &url)
{
    static const uint32_t gaps[] = { 3000, 10000 };
    for (int k = 0; k < POST_MAX_BATCHES; k++) {
        int n = logq_next(batch, BATCH_MAX);
        if (!n) return;
        int code = 0;
        for (int attempt = 0; attempt <= 2; attempt++) {
            if (attempt) {
                Serial.printf("[api] retry in %u s\n", (unsigned)(gaps[attempt - 1] / 1000));
                vTaskDelay(pdMS_TO_TICKS(gaps[attempt - 1]));
                if (net_state() != NET_CONNECTED) return;
            }
            code = post_batch(client, url, n);
            if (code > 0 && code < 500) break; // only 5xx / network errors are worth retrying
        }
        if (code == 400 || code == 413 || code == 422) {
            Serial.printf("[api] batch rejected (%d), dropped so the queue can move on\n", code);
            logq_done();
            continue;
        }
        if (code < 200 || code >= 300) {
            if (code == 401 || code == 403) Serial.println("[api] check the API key (setup page / POST /api/backend)");
            post_failed = true;
            Serial.printf("[api] POST failed (%d), kept on %s; next try in a minute\n", code,
                          logq_pending_files() ? "the queue" : "RAM");
            return;
        }
        logq_done();
        ok_at = millis() | 1;
    }
}

// ---- GET data ---------------------------------------------------------------
// GET /api/module/config: { usage_states: [{name, measured_at, session{used_pct, resets_at}, week{...}, month{...}}],
//                           events: [{id, title, location, start, end}], firmware: {version}, server_time }
static void parse_usage(JsonObjectConst u, api_usage_t *d)
{
    d->seen = d->present = true;
    d->session_pct = (int)lroundf(u["session"]["used_pct"] | -1.0f);
    d->week_pct = (int)lroundf(u["week"]["used_pct"] | -1.0f);
    d->month_pct = (int)lroundf(u["month"]["used_pct"] | -1.0f);
    d->session_reset = u["session"]["resets_at"] | 0L;
    d->measured_at = u["measured_at"] | 0L;
}

static bool parse(const String &body, api_data_t *d)
{
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, body);
    if (err) {
        Serial.printf("[api] bad JSON: %s\n", err.c_str());
        return false;
    }
    d->valid = true;
    d->fetched_at = time(nullptr);
    fwupdate_offer(doc["firmware"]["version"]);
    d->claude.present = d->copilot.present = false; // last values stay, shown grey
    for (JsonObjectConst u : doc["usage_states"].as<JsonArrayConst>()) {
        const char *name = u["name"] | "";
        if (!strcmp(name, "claude")) parse_usage(u, &d->claude);
        else if (!strcmp(name, "copilot")) parse_usage(u, &d->copilot);
    }
    time_t now = time(nullptr);
    d->n_meetings = 0;
    for (JsonObjectConst m : doc["events"].as<JsonArrayConst>()) { // already sorted by start
        time_t start = m["start"] | 0L, end = m["end"] | 0L;
        if (!start || !end || end <= now || d->n_meetings == API_MAX_MEET) continue;
        api_meeting_t &x = d->meetings[d->n_meetings++];
        strlcpy(x.title, m["title"] | "(no title)", sizeof x.title);
        strlcpy(x.location, m["location"] | "", sizeof x.location); // null / missing -> ""
        x.start = start;
        x.end = end;
    }
    long drift = (long)((doc["server_time"] | 0L) - (long)now);
    if (doc["server_time"].is<long>() && labs(drift) > 30) Serial.printf("[api] clock drift %ld s vs server\n", drift);
    return true;
}

// Returns seconds to wait before the next GET (Retry-After on 429), 0 = normal schedule.
static int get_data(NetworkClient &client, const String &url)
{
    HTTPClient http;
    if (!http.begin(client, url + API_GET_PATH)) return 0;
    add_headers(http);
    const char *keep[] = { "Retry-After" };
    http.collectHeaders(keep, 1);
    uint32_t t0 = millis();
    int code = http.GET();
    String body = code > 0 ? http.getString() : String();
    int retry = code == 429 ? max(1, (int)http.header("Retry-After").toInt()) : 0;
    http.end();
    Serial.printf("[api] GET config -> %d, %u bytes (%u ms)\n", code, body.length(), (unsigned)(millis() - t0));
    lock();
    last_code = code;
    last_at = time(nullptr);
    unlock();
    if (code != 200) {
        if (code > 0) Serial.printf("[api] %s\n", body.substring(0, 200).c_str());
        return retry ? retry : 0; // keep the last good data (shown grey once stale)
    }

    static api_data_t fresh; // static: keeps the task stack small
    lock();
    fresh = data;            // start from the last data: usage values survive a missing tool
    unlock();
    if (!parse(body, &fresh)) return 0;
    Serial.printf("[api] claude %s %d/%d%%, copilot %s %d%%, %d event(s)\n",
                  fresh.claude.present ? "ok" : "--", fresh.claude.session_pct, fresh.claude.week_pct,
                  fresh.copilot.present ? "ok" : "--", fresh.copilot.month_pct,
                  fresh.n_meetings);
    lock();
    data = fresh;
    rev++;
    unlock();
    return 0;
}

// ---- task -------------------------------------------------------------------
static void api_task(void *)
{
    time_t next_post = 0, next_get = 0; // 0 = right away (boot)
    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(500));
        fwupdate_poll();
        if (net_state() != NET_CONNECTED || !net_time_synced()) continue;
        time_t now = time(nullptr);
        bool do_post = now >= next_post, do_get = now >= next_get;
        if (!do_post && !do_get) continue;
        String url = net_api_url();
        if (!url.length() || !net_api_token().length()) { // not configured: readings keep queuing
            static bool told = false;
            if (!told) { told = true; Serial.println("[api] backend URL / key not set: readings stay queued"); }
            post_failed = true;
            next_post = (now / 60 + 1) * 60;
            next_get = next_post;
            continue;
        }
        NetworkClientSecure tls;
        tls.setCACertBundle(ca_bundle_start, ca_bundle_end - ca_bundle_start);
        NetworkClient plain;
        NetworkClient &client = url.startsWith("http://") ? plain : tls; // http:// for local backend tests
        if (do_post) {
            post_queue(client, url);
            next_post = (time(nullptr) / 60 + 1) * 60;
            lock();
            next_at = next_post;
            unlock();
        }
        if (do_get) {
            int wait = get_data(client, url);
            now = time(nullptr);
            next_get = wait ? now + wait : (now / 60 + 1) * 60 + 2; // after the minute's POST
        }
    }
}

// ---- public -------------------------------------------------------------------
void api_begin(const char *fw_version)
{
    fw = fw_version;
    mux = xSemaphoreCreateMutex();
    set_defaults(&data);
    batch = (log_rec_t *)heap_caps_malloc(BATCH_MAX * sizeof(log_rec_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    body = (char *)heap_caps_malloc(BODY_CAP, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    xTaskCreatePinnedToCore(api_task, "api", 12 * 1024, nullptr, 1, nullptr, 0);
}

void api_set_power(const char *source, int batt_mv, int batt_pct)
{
    lock();
    pwr_source = source;
    pwr_mv = batt_mv;
    pwr_pct = batt_pct;
    unlock();
}

void api_get(api_data_t *out)
{
    lock();
    *out = data;
    unlock();
}

api_sync_t api_sync_state()
{
    if (posting) return API_SYNC_BUSY;
    if (post_failed) return API_SYNC_FAILED;
    if (ok_at && millis() - ok_at < API_SYNC_OK_MS) return API_SYNC_OK;
    return API_SYNC_IDLE;
}

uint32_t api_rev()
{
    lock();
    uint32_t r = rev;
    unlock();
    return r;
}

void api_last(int *http_code, time_t *at, time_t *next)
{
    lock();
    *http_code = last_code;
    *at = last_at;
    *next = next_at;
    unlock();
}
