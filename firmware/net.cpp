// net.cpp — Wi-Fi: saved networks (NVS), setup portal (soft AP + captive page), NTP
//
// Normal mode: full scan, keep only the saved networks that are in range, try them strongest
// signal first. Boot (never connected yet): none works -> setup portal. After a connection was
// up once, a drop never opens the portal: the header shows Wi-Fi off and the scan repeats every
// RETRY_MS (RST reboots into the boot flow). NTP once connected.
// Portal mode: scan once, then start a WPA2 soft AP "workdesk" (random password kept in
// NVS) on the channel of the most likely target network, so the phone is not kicked off when
// the STA side joins (an ESP32 soft AP has to follow the STA's channel). DNS answers every
// name with our IP so phones pop up the captive page. New credentials are only saved after
// they actually connect. The page also lists the saved networks with a Forget button.
#include "net.h"
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <esp_sntp.h>
#include <esp_wifi.h>
#include <esp_mac.h>
#include <ArduinoOTA.h>

extern "C" const uint8_t web_jbm_400[], web_jbm_700[];  // web_font.c
extern "C" const size_t web_jbm_400_len, web_jbm_700_len;

#define MAX_NETS          5
#define MAX_SEEN          20
#define JOIN_TIMEOUT_MS   20000  // portal: give up on new credentials after this
#define SCAN_MS_PER_CH      120  // active scan dwell per channel (default 300)
#define TRY_TIMEOUT_MS    12000  // normal mode: per saved network after a scan
#define SCAN_TIMEOUT_MS   10000
#define RETRY_MS          30000  // normal mode: start over this long after every network failed
#define PORTAL_DONE_MS     3000  // portal: show "connected" this long before closing the AP
#define AUTO_PORTAL_IDLE_MS (5 * 60 * 1000) // auto-opened portal with no phone: close, retry saved networks

static Preferences prefs;
static WebServer server(80);
static DNSServer dns;

static net_state_t state = NET_OFF;
static char ap_ssid[20], ap_pass[12], dev_id[20];
static String api_token, api_url;   // backend (Workdesk): key + base URL, NVS "api_token" / "api_url"
static SemaphoreHandle_t cfg_mux;     // the api task reads them while the portal / web page may write
static bool mac_custom = false;
static char status[64] = "";
static bool ever_connected = false;
static int failed_rounds = 0;
static bool portal_auto = false;         // opened by the connect cycle, not by the user
static uint32_t portal_at = 0, reboot_at = 0;  // reboot_at: 0 = none
static const char *reboot_why = "";

static void set_status(const char *fmt, const char *arg = "")
{
    snprintf(status, sizeof status, fmt, arg);
}
static bool ota_started = false;
static void (*ota_cb)(int) = nullptr;
static volatile bool time_synced = false;
static bool ntp_started = false;

// STA disconnect events (Wi-Fi task). WiFi.status() keeps the previous attempt's result for a
// while after begin(), so a join only counts as failed on a disconnect event that came after it.
static volatile uint32_t disc_count = 0;
static volatile uint8_t disc_reason = 0;
static uint32_t join_disc = 0;           // disc_count when the current attempt started

static bool join_failed()
{
    if (disc_count == join_disc) return false;
    uint8_t r = disc_reason;
    return r != WIFI_REASON_ASSOC_LEAVE && r != WIFI_REASON_AUTH_LEAVE; // our own disconnect()
}

// Join failure in plain words for the setup page: a short title (also on the device screen)
// and what to try. reason 0 = no answer before the timeout.
struct fail_text_t { const char *title, *hint; };
static fail_text_t fail_text(uint8_t r)
{
    switch (r) {
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE:
    case WIFI_REASON_AUTH_EXPIRE:
        return { "Wrong password",
                 "The router rejected the password. Passwords are case-sensitive: tap SHOW to check "
                 "what you typed (watch for a capital first letter added by the phone)." };
    case WIFI_REASON_NO_AP_FOUND:
    case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
        return { "Network not found",
                 "The device can't see this network right now. Move it closer to the router, check the "
                 "name, and make sure the router has 2.4 GHz turned on (5 GHz-only is not supported)." };
    case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
    case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
    case WIFI_REASON_802_1X_AUTH_FAILED:
        return { "Security type not supported",
                 "This network uses a login type the device can't use (e.g. company login with a "
                 "username). Use a home network or a phone hotspot instead." };
    case WIFI_REASON_ASSOC_TOOMANY:
        return { "Router is full",
                 "The router has too many devices connected. Disconnect one, or restart the router." };
    case WIFI_REASON_BEACON_TIMEOUT:
    case WIFI_REASON_ASSOC_EXPIRE:
    case WIFI_REASON_AUTH_LEAVE:
    case WIFI_REASON_ASSOC_LEAVE:
        return { "Connection dropped",
                 "The connection started but was lost, usually a weak signal. Move the device closer "
                 "to the router and try again." };
    case WIFI_REASON_NOT_AUTHED:
    case WIFI_REASON_NOT_ASSOCED:
    case WIFI_REASON_CONNECTION_FAIL:
    case WIFI_REASON_AP_TSF_RESET:
        return { "Router refused the device",
                 "The router turned the device away. It may block new devices (MAC filter / allow "
                 "list) or be busy. Check the router settings, or wait a moment and try again." };
    case 0:
        return { "No answer from the router",
                 "The router did not reply in time. The signal may be too weak, or the router is "
                 "busy. Move closer and try again." };
    default:
        return { "Could not connect",
                 "Something went wrong while joining. Try again; if it keeps failing, restart the "
                 "router or try another network." };
    }
}

// saved networks, most recently used first. ch / bssid: where it was last joined (ch 0 = unknown)
struct cred_t { String ssid, pass; uint8_t ch; uint8_t bssid[6]; };
static cred_t nets[MAX_NETS];
static int n_nets = 0;

// a join attempt: saved network index + channel / BSSID hint (ch 0 = let the driver scan)
struct try_t { int idx; uint8_t ch; uint8_t bssid[6]; };

// normal mode connect cycle
enum { C_SCAN, C_JOIN, C_GAP, C_WAIT };
#define RETRY_GAP_MS 1000
static bool auth_retried = false;        // current network already retried after AUTH_FAIL
static int cphase = C_WAIT;
static try_t order[MAX_NETS];
static int n_order = 0, try_i = 0;
static uint32_t phase_at = 0, cycle_t0 = 0;

// portal
struct seen_t { String ssid; int rssi; uint8_t ch; uint8_t bssid[6]; bool open; uint8_t auth; };
static seen_t seen[MAX_SEEN];            // last scan, one entry per SSID, strongest first
static int n_seen = 0;
static int ap_ch = 1;
static bool joining = false;             // trying the credentials from the form
static bool join_sent = false;           // WiFi.begin() issued (a moment after the reply)
static bool join_retried = false;        // portal join already retried after AUTH_FAIL
static uint32_t join_wait = 300;         // delay before the (re)join is issued
static String join_ssid, join_pass;
static uint32_t join_at = 0, done_at = 0;
static String msg, msg_hint; // msg: short (page + device screen); msg_hint: page only
static bool msg_err = false;
static uint32_t msg_rev = 0;

static void set_msg(const String &m, bool err = false, const String &hint = "")
{
    msg = m;
    msg_hint = hint;
    msg_err = err;
    msg_rev++;
    Serial.printf("[net] %s\n", m.c_str());
}

static void on_time_sync(struct timeval *) { time_synced = true; }

// Every planned reboot goes through here so the screen can warn first (net_reboot_in()).
static void schedule_reboot(uint32_t ms, const char *why)
{
    reboot_at = millis() + ms;
    if (!reboot_at) reboot_at = 1;
    reboot_why = why;
    Serial.printf("[net] reboot in %u ms: %s\n", (unsigned)ms, why);
}

static void start_ota()
{
    if (ota_started) return;
    ota_started = true;
    ArduinoOTA.setHostname("workdesk");  // workdesk.local
    ArduinoOTA.setPassword(ap_pass);
    ArduinoOTA.setRebootOnSuccess(false);  // reboot after the on-screen warning instead
    ArduinoOTA.onStart([] { Serial.println("[ota] start"); net_ota_report(0); });
    ArduinoOTA.onProgress([](unsigned int done, unsigned int total) {
        net_ota_report(total ? done * 99 / total : 0);
    });
    ArduinoOTA.onEnd([] { net_ota_report(100); });
    ArduinoOTA.onError([](ota_error_t e) { Serial.printf("[ota] error %d\n", e); net_ota_report(-1); });
    ArduinoOTA.begin();
    Serial.println("[ota] ready: workdesk.local");
}

static void start_ntp()
{
    if (ntp_started) return;
    ntp_started = true;
    sntp_set_time_sync_notification_cb(on_time_sync);
    configTzTime(TZ_INFO, "pool.ntp.org", "time.google.com");
}

// ---- saved networks (NVS keys: n, s0..s4, p0..p4, c0..c4, b0..b4) -----------
static String key(char k, int i) { return String(k) + String(i); }

static void nets_save()
{
    prefs.putUChar("n", n_nets);
    for (int i = 0; i < MAX_NETS; i++) {
        if (i < n_nets) {
            prefs.putString(key('s', i).c_str(), nets[i].ssid);
            prefs.putString(key('p', i).c_str(), nets[i].pass);
            prefs.putUChar(key('c', i).c_str(), nets[i].ch);
            prefs.putBytes(key('b', i).c_str(), nets[i].bssid, 6);
        } else {
            for (char k : {'s', 'p', 'c', 'b'}) prefs.remove(key(k, i).c_str());
        }
    }
}

static void nets_load()
{
    n_nets = 0;
    int n = prefs.getUChar("n", 0);
    for (int i = 0; i < n && i < MAX_NETS; i++) {
        String s = prefs.getString(key('s', i).c_str(), "");
        if (!s.length()) continue;
        cred_t &c = nets[n_nets++];
        c.ssid = s;
        c.pass = prefs.getString(key('p', i).c_str(), "");
        c.ch = prefs.getUChar(key('c', i).c_str(), 0);
        if (prefs.getBytes(key('b', i).c_str(), c.bssid, 6) != 6) c.ch = 0;
    }
    // first firmware stored a single network under "ssid" / "pass"
    if (prefs.isKey("ssid")) {
        String s = prefs.getString("ssid", "");
        if (s.length() && n_nets == 0) {
            nets[0] = cred_t();
            nets[0].ssid = s;
            nets[0].pass = prefs.getString("pass", "");
            n_nets = 1;
        }
        prefs.remove("ssid");
        prefs.remove("pass");
        nets_save();
    }
}

static int nets_find(const String &ssid)
{
    for (int i = 0; i < n_nets; i++)
        if (nets[i].ssid == ssid) return i;
    return -1;
}

// Called when connected: add / update the network, move it to the front, remember where it is.
// A full list drops the last (least recently used). Skips the flash write when nothing changed.
// By value: callers pass nets[i].ssid / .pass, which the shift below overwrites.
static void nets_connected(String ssid, String pass)
{
    uint8_t ch = WiFi.channel();
    const uint8_t *bssid = WiFi.BSSID();
    int i = nets_find(ssid);
    if (i == 0 && nets[0].pass == pass && nets[0].ch == ch && bssid && !memcmp(nets[0].bssid, bssid, 6)) return;

    if (i < 0) i = n_nets < MAX_NETS ? n_nets++ : MAX_NETS - 1;
    for (; i > 0; i--) nets[i] = nets[i - 1];
    nets[0].ssid = ssid;
    nets[0].pass = pass;
    nets[0].ch = bssid ? ch : 0;
    if (bssid) memcpy(nets[0].bssid, bssid, 6);
    nets_save();
}

static void nets_remove(int i)
{
    if (i < 0 || i >= n_nets) return;
    for (; i < n_nets - 1; i++) nets[i] = nets[i + 1];
    n_nets--;
    nets[n_nets] = cred_t();
    nets_save();
}

static void wifi_join(const String &ssid, const String &pass, uint8_t ch, const uint8_t *bssid)
{
    join_disc = disc_count;
    // Arduino's begin() zeroes the STA config, which leaves sae_pwe_h2e = 0 (WPA3 hunt-and-peck
    // only). WPA2/WPA3 routers that need H2E then reject the first joins with AUTH_FAIL (202).
    // So: write the config without connecting, allow both SAE methods (IDF default), connect.
    WiFi.begin(ssid.c_str(), pass.c_str(), ch, ch ? bssid : nullptr, false); // ch + BSSID skip the driver's scan
    wifi_config_t conf;
    if (esp_wifi_get_config(WIFI_IF_STA, &conf) == ESP_OK) {
        conf.sta.sae_pwe_h2e = WPA3_SAE_PWE_BOTH;
        esp_wifi_set_config(WIFI_IF_STA, &conf);
    }
    esp_wifi_connect();
}

// ---- normal mode: scan -> saved networks in range, strongest first -> wait ----
// A join needs a fresh scan result for the AP: a blind begin() with channel + BSSID gets
// AUTH_FAIL (202) on WPA2/WPA3 routers, the same credentials work right after a scan.
static void scan_start()
{
    set_status("Scanning for saved networks...");
    WiFi.disconnect(false);
    WiFi.scanDelete();
    WiFi.scanNetworks(true, false, false, SCAN_MS_PER_CH);
    cphase = C_SCAN;
    phase_at = millis();
}

static void try_next()
{
    if (try_i >= n_order) {
        failed_rounds++;
        Serial.printf("[net] no saved network worked (round %d)\n", failed_rounds);
        if (!ever_connected) { // boot: nothing usable here -> let the user pick
            net_start_portal();
            portal_auto = true;
            set_msg(n_order ? "Could not join a saved Wi-Fi. Choose a network." : "No saved Wi-Fi found here. Choose a network.");
            return;
        }
        set_status("Wi-Fi lost. Retrying soon...");
        cphase = C_WAIT;
        phase_at = millis();
        return;
    }
    const try_t &t = order[try_i++];
    Serial.printf("[net] trying %s (ch %d)\n", nets[t.idx].ssid.c_str(), t.ch);
    set_status("Joining %s...", nets[t.idx].ssid.c_str());
    wifi_join(nets[t.idx].ssid, nets[t.idx].pass, t.ch, t.bssid);
    cphase = C_JOIN;
    phase_at = millis();
}

static void cycle_start()
{
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(false); // the cycle below decides what to join
    if (state != NET_CONNECTING) cycle_t0 = millis();
    state = NET_CONNECTING;
    auth_retried = false;
    scan_start();
}

// Saved networks seen in the scan, strongest signal first (best guess for the fastest link), each
// with its strongest AP's channel / BSSID. Networks not in range are skipped.
static void build_order(int found)
{
    int rssi[MAX_NETS];
    for (int i = 0; i < n_nets; i++) {
        rssi[i] = -1000;
        order[i].idx = i;
        order[i].ch = 0;
        for (int k = 0; k < found; k++) {
            if (WiFi.SSID(k) != nets[i].ssid || WiFi.RSSI(k) <= rssi[i]) continue;
            rssi[i] = WiFi.RSSI(k);
            order[i].ch = WiFi.channel(k);
            memcpy(order[i].bssid, WiFi.BSSID(k), 6);
        }
    }
    n_order = n_nets;
    for (int a = 1; a < n_order; a++)  // insertion sort, stable for equal signal
        for (int b = a; b > 0 && rssi[order[b].idx] > rssi[order[b - 1].idx]; b--) {
            try_t t = order[b]; order[b] = order[b - 1]; order[b - 1] = t;
        }
    while (n_order && rssi[order[n_order - 1].idx] == -1000) n_order--; // drop the unseen
    for (int i = 0; i < n_order; i++)
        Serial.printf("  %d. %s  %d dBm  ch %d\n", i + 1, nets[order[i].idx].ssid.c_str(), rssi[order[i].idx], order[i].ch);
}

static void connect_loop()
{
    uint32_t dt = millis() - phase_at;
    switch (cphase) {
    case C_SCAN: {
        int found = WiFi.scanComplete();
        if (found == WIFI_SCAN_RUNNING && dt < SCAN_TIMEOUT_MS) return;
        Serial.printf("[net] scan: %d found in %u ms\n", found > 0 ? found : 0, (unsigned)dt);
        build_order(found > 0 ? found : 0);
        WiFi.scanDelete();
        try_i = 0;
        try_next();
        break;
    }
    case C_JOIN: {
        wl_status_t st = WiFi.status();
        if (st == WL_CONNECTED) {
            const cred_t &c = nets[order[try_i - 1].idx];
            state = NET_CONNECTED;
            Serial.printf("[net] connected to %s in %u ms, IP %s, ch %d, %d dBm\n", c.ssid.c_str(),
                          (unsigned)(millis() - cycle_t0), WiFi.localIP().toString().c_str(),
                          WiFi.channel(), WiFi.RSSI());
            nets_connected(c.ssid, c.pass);
            ever_connected = true;
            failed_rounds = 0;
            auth_retried = false;
            set_status("Connected");
            start_ntp();
        } else if (join_failed() || dt > TRY_TIMEOUT_MS) {
            Serial.printf("[net] failed (reason %d) after %u ms\n", join_failed() ? disc_reason : 0, (unsigned)dt);
            WiFi.disconnect(false);
            if (join_failed() && disc_reason == WIFI_REASON_AUTH_FAIL && !auth_retried) {
                // WPA2/WPA3 routers often reject the first join after the radio starts, even with
                // the right password; the same join a moment later works. Retry once.
                auth_retried = true;
                try_i--;
                set_status("Retrying %s...", nets[order[try_i].idx].ssid.c_str());
                cphase = C_GAP;
                phase_at = millis();
            } else {
                auth_retried = false;
                try_next();
            }
        }
        break;
    }
    case C_GAP:
        if (dt > RETRY_GAP_MS) try_next();
        break;
    case C_WAIT:
        if (dt > RETRY_MS) cycle_start();
        break;
    }
}

// ---- portal scan ---------------------------------------------------------------
// Blocking scan (~2-3 s). Only at portal start (before the AP is up) or on "Refresh list":
// while scanning the radio leaves the AP channel and the phone loses the page.
static void portal_scan()
{
    uint32_t t0 = millis();
    int found = WiFi.scanNetworks(false, false, false, SCAN_MS_PER_CH);
    n_seen = 0;
    for (int k = 0; k < found; k++) {
        String s = WiFi.SSID(k);
        if (!s.length()) continue;
        int j = 0;
        while (j < n_seen && seen[j].ssid != s) j++;
        if (j < n_seen) {
            if (WiFi.RSSI(k) <= seen[j].rssi) continue;
        } else {
            if (n_seen == MAX_SEEN) continue;
            n_seen++;
        }
        seen[j].ssid = s;
        seen[j].rssi = WiFi.RSSI(k);
        seen[j].ch = WiFi.channel(k);
        seen[j].auth = WiFi.encryptionType(k);
        seen[j].open = seen[j].auth == WIFI_AUTH_OPEN;
        memcpy(seen[j].bssid, WiFi.BSSID(k), 6);
    }
    WiFi.scanDelete();
    for (int a = 1; a < n_seen; a++)
        for (int b = a; b > 0 && seen[b].rssi > seen[b - 1].rssi; b--) {
            seen_t t = seen[b]; seen[b] = seen[b - 1]; seen[b - 1] = t;
        }
    Serial.printf("[net] portal scan: %d networks in %u ms\n", n_seen, (unsigned)(millis() - t0));
    for (int i = 0; i < n_seen; i++)
        Serial.printf("  %-32s ch %2d  %4d dBm  auth %d\n", seen[i].ssid.c_str(), seen[i].ch, seen[i].rssi, seen[i].auth);
}

static const seen_t *seen_find(const String &ssid)
{
    for (int i = 0; i < n_seen; i++)
        if (seen[i].ssid == ssid) return &seen[i];
    return nullptr;
}

// AP channel = channel of the network the user will most likely pick:
// strongest saved network in range, else the strongest network overall.
static int portal_channel()
{
    for (int i = 0; i < n_seen; i++)
        if (nets_find(seen[i].ssid) >= 0) return seen[i].ch;
    return n_seen ? seen[0].ch : 1;
}

// ---- web page ---------------------------------------------------------------
static bool is_enterprise(uint8_t a)
{
    return a == WIFI_AUTH_ENTERPRISE || a == WIFI_AUTH_WPA3_ENTERPRISE ||
           a == WIFI_AUTH_WPA2_WPA3_ENTERPRISE || a == WIFI_AUTH_WPA3_ENT_192;
}

static String html_escape(const String &s)
{
    String o;
    o.reserve(s.length() + 8);
    for (char c : s) {
        switch (c) {
        case '&': o += "&amp;"; break;
        case '<': o += "&lt;"; break;
        case '>': o += "&gt;"; break;
        case '"': o += "&quot;"; break;
        case '\'': o += "&#39;"; break;
        default: o += c;
        }
    }
    return o;
}

static const char PAGE_HEAD[] PROGMEM =
    "<!doctype html><html><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'><title>workdesk setup</title><style>"
    "@font-face{font-family:JBM;src:url(/f400.woff2) format('woff2');font-weight:400;font-display:swap}"
    "@font-face{font-family:JBM;src:url(/f700.woff2) format('woff2');font-weight:700;font-display:swap}"
    "*{box-sizing:border-box}[hidden]{display:none!important}"
    "body{font:15px JBM,ui-monospace,monospace;background:#000;color:#f2f2f2;max-width:440px;margin:auto;padding:24px 18px}"
    "h2{color:#f5a524;font-weight:700;font-size:18px;letter-spacing:1px}"
    "h3{color:#8a8a8a;font-size:13px;font-weight:400;letter-spacing:1px;margin:28px 0 8px}"
    "label.f{display:block;color:#8a8a8a;font-size:13px;margin-top:14px}a{color:#4fd1e8}"
    "input,button{display:block;width:100%;font:inherit;padding:12px;margin:6px 0 0;border-radius:8px;"
    "border:1px solid #3a3a3a;background:#000;color:#f2f2f2}"
    "button{background:#f5a524;color:#000;border:0;font-weight:700;margin-top:20px}"
    ".n{display:block;margin:0}.n input{display:none}"
    ".n div{display:flex;gap:10px;align-items:center;padding:13px 12px;border:1px solid #262626;border-radius:8px;margin:6px 0}"
    ".n input:checked+div{border-color:#f5a524}"
    ".n b{flex:1;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    ".n i{font-style:normal;color:#8a8a8a;font-size:13px}.n i.s{color:#4fd1e8}"
    ".r{display:flex;align-items:center;gap:12px;border-bottom:1px solid #262626}"
    ".r span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    ".r button{width:auto;margin:8px 0;padding:8px 14px;background:none;border:1px solid #ff5252;"
    "color:#ff5252;font-weight:400}"
    ".m{color:#4fd1e8}.e{color:#ff5252}.d{color:#8a8a8a;font-size:13px}.n i.x{color:#ff5252}"
    ".pw{display:block;position:relative}.pw input{padding-right:76px}"
    ".pw button{position:absolute;right:6px;top:6px;bottom:0;margin:auto 0;width:auto;height:36px;"
    "padding:0 12px;background:none;border:1px solid #3a3a3a;color:#8a8a8a;font-weight:400;font-size:13px}"
    "</style><script>function t(b){const i=b.previousElementSibling,s=i.type==='password';"
    "i.type=s?'text':'password';b.textContent=s?'HIDE':'SHOW'}</script></head><body><h2>WORKDESK WI-FI</h2>";

// Show the name box for "Other network...", hide the password for open networks.
static const char PAGE_JS[] PROGMEM =
    "<script>const f=document.forms.j;function u(){const r=f.querySelector('[name=s]:checked');"
    "const o=r&&r.value==='';f.h.hidden=!o;f.h.required=o;"
    "const op=r&&r.dataset.o;document.getElementById('pl').hidden=!!op;if(op)f.p.value=''}"
    "f.addEventListener('change',u);u()</script>";

static void send_page(const String &body)
{
    String p = FPSTR(PAGE_HEAD);
    p += body;
    p += "</body></html>";
    server.send(200, "text/html", p);
}

static void handle_root()
{
    String b;
    if (msg.length()) b += "<p class=" + String(msg_err ? "e" : "m") + ">" + html_escape(msg) + "</p>";
    if (msg_hint.length()) b += "<p class=d>" + html_escape(msg_hint) + "</p>";

    // preselect: last tried network, else the strongest saved one, else the strongest overall
    int pick = -1;
    for (int i = 0; i < n_seen && pick < 0; i++) if (seen[i].ssid == join_ssid) pick = i;
    for (int i = 0; i < n_seen && pick < 0; i++) if (nets_find(seen[i].ssid) >= 0) pick = i;
    if (pick < 0 && n_seen) pick = 0;

    b += "<form name=j method=post action=/save><h3>CHOOSE A NETWORK</h3>";
    for (int i = 0; i < n_seen; i++) {
        String e = html_escape(seen[i].ssid);
        b += "<label class=n><input type=radio name=s value='" + e + "'";
        if (seen[i].open) b += " data-o=1";
        if (i == pick) b += " checked";
        b += "><div><b>" + e + "</b>";
        if (nets_find(seen[i].ssid) >= 0) b += "<i class=s>saved</i>";
        if (seen[i].open) b += "<i>open</i>";
        if (is_enterprise(seen[i].auth)) b += "<i class=x>802.1X</i>";
        b += "<i>" + String(seen[i].rssi) + " dBm</i></div></label>";
    }
    b += "<label class=n><input type=radio name=s value=''";
    if (pick < 0) b += " checked";
    b += "><div><b>Other network...</b></div></label>"
         "<input name=h maxlength=32 placeholder='Network name' autocomplete=off autocapitalize=off hidden>"
         "<label class=f id=pl>Password<span class=pw><input name=p type=password maxlength=63 "
         "autocomplete=off autocapitalize=off autocorrect=off spellcheck=false>"
         "<button type=button onclick=t(this)>SHOW</button></span></label>"
         "<button>Save &amp; connect</button></form>"
         "<p class=d>" + String(n_seen) + " networks found &middot; <a href=/scan>Refresh</a> "
         "(page pauses a few seconds)</p>";

    b += "<h3>SAVED NETWORKS (" + String(n_nets) + "/" + String(MAX_NETS) + ")</h3>";
    if (n_nets == 0) b += "<p class=d>None yet.</p>";
    for (int i = 0; i < n_nets; i++) {
        String e = html_escape(nets[i].ssid);
        b += "<form class=r method=post action=/forget>"
             "<input type=hidden name=i value=" + String(i) + "><input type=hidden name=s value='" + e + "'>"
             "<span>" + e + "</span><button>Forget</button></form>";
    }
    if (n_nets == MAX_NETS) b += "<p class=d>List is full: a new network replaces the least recently used one.</p>";

    String url = net_api_url(), hint = net_api_key_hint();
    b += "<h3>BACKEND</h3><form method=post action=/token><p class=d>Workdesk URL and the API key made "
         "for this module (Settings &rarr; API keys, endpoint &quot;module&quot;). Key: " +
         (hint.length() ? html_escape(hint) : String("not set")) + ".</p>"
         "<label class=f>URL<input name=u maxlength=128 autocomplete=off autocapitalize=off autocorrect=off "
         "spellcheck=false placeholder='https://workdesk.example.com' value='" + html_escape(url) + "'></label>"
         "<label class=f>API key<span class=pw><input name=t type=password maxlength=128 autocomplete=off "
         "autocapitalize=off autocorrect=off spellcheck=false placeholder='" +
         String(hint.length() ? "Leave empty to keep the saved key" : "wdk_...") + "'>"
         "<button type=button onclick=t(this)>SHOW</button></span></label>"
         "<button>Save backend</button></form>";
    if (hint.length())
        b += "<form method=post action=/token><input type=hidden name=clear value=1>"
             "<button style='background:none;border:1px solid #ff5252;color:#ff5252;font-weight:400'>Remove key</button></form>";

    b += "<h3>DEVICE MAC</h3><form method=post action=/mac><p class=d>In use: " +
         net_mac() + (mac_custom ? " (custom)" : " (factory)") +
         ". For networks that only allow registered devices.</p>"
         "<input name=m maxlength=17 autocomplete=off autocapitalize=off placeholder='aa:bb:cc:dd:ee:ff'>"
         "<button>Save MAC</button></form>";
    if (mac_custom)
        b += "<form method=post action=/mac>"
             "<input type=hidden name=factory value=1>"
             "<button style='background:none;border:1px solid #3a3a3a;color:#f2f2f2;font-weight:400'>Use factory MAC</button></form>";
    b += FPSTR(PAGE_JS);
    send_page(b);
}

static void send_font(const uint8_t *data, size_t len)
{
    server.sendHeader("Cache-Control", "public, max-age=31536000, immutable");
    server.send_P(200, "font/woff2", (const char *)data, len);
}

static void handle_scan()
{
    if (!joining && !done_at) portal_scan();
    server.sendHeader("Location", "/", true);
    server.send(303, "text/plain", "");
}

static void handle_save()
{
    String s = server.arg("s"), p = server.arg("p");
    if (!s.length()) s = server.arg("h"); // "Other network..."
    s.trim();
    if (s.length() < 1 || s.length() > 32) {
        set_msg("Network name must be 1-32 characters.", true);
    } else if (p.length() != 0 && (p.length() < 8 || p.length() > 63)) {
        set_msg("Password must be 8-63 characters (or empty for an open network).", true);
    } else if (seen_find(s) && is_enterprise(seen_find(s)->auth)) {
        set_msg(s + " uses 802.1X (company login with username). Not supported yet.", true);
    } else {
        join_ssid = s;
        join_pass = p;
        joining = true;
        join_at = millis();
        const seen_t *sn = seen_find(s);
        set_msg("Connecting to " + s + "...");
        String note;
        if (sn && sn->ch != ap_ch)
            note = " Your phone may drop off " + String(ap_ssid) + " for a moment (channel change).";
        send_page("<p class=m>Connecting to " + html_escape(s) + "...</p><p>Watch the device screen." + note +
                  " If it fails, rejoin " + String(ap_ssid) + " and open this page again.</p>");
        join_sent = false; // portal_loop joins in a moment: on a channel change the phone would miss this reply
        join_retried = false;
        join_wait = 300;
        return;
    }
    handle_root();
}

static void handle_forget()
{
    int i = server.arg("i").toInt();
    String s = server.arg("s");
    if (i >= 0 && i < n_nets && nets[i].ssid == s) { // name check: the list may have changed since the page loaded
        nets_remove(i);
        set_msg("Forgot " + s + ".");
    }
    server.sendHeader("Location", "/", true);
    server.send(303, "text/plain", "");
}

static void handle_token()
{
    String err;
    if (server.hasArg("clear")) {
        net_set_backend(nullptr, "", &err);
        set_msg("API key removed.");
    } else if (net_set_backend(server.arg("u").c_str(), server.arg("t").c_str(), &err)) {
        set_msg("Backend saved.");
    } else {
        set_msg(err, true);
    }
    server.sendHeader("Location", "/", true);
    server.send(303, "text/plain", "");
}

static void handle_redirect()
{
    server.sendHeader("Location", String("http://") + WiFi.softAPIP().toString() + "/", true);
    server.send(302, "text/plain", "");
}

// ---- portal -----------------------------------------------------------------
// "aa:bb:cc:dd:ee:ff", "aa-bb-...", or 12 hex digits -> bytes. Must be unicast (bit 0 of byte 0 clear).
static bool parse_mac(String t, uint8_t out[6])
{
    t.replace(":", "");
    t.replace("-", "");
    t.trim();
    if (t.length() != 12) return false;
    for (int i = 0; i < 6; i++) {
        char hex[3] = { t[2 * i], t[2 * i + 1], 0 };
        char *end;
        out[i] = (uint8_t)strtoul(hex, &end, 16);
        if (*end) return false;
    }
    bool zero = true, ff = true;
    for (int i = 0; i < 6; i++) { zero &= out[i] == 0; ff &= out[i] == 0xFF; }
    return !(out[0] & 1) && !zero && !ff;
}

// Change the STA MAC without a reboot. esp_wifi_set_mac() needs the driver stopped (with the
// STA interface still in the mode), so stop Wi-Fi for ~1 s: the AP restarts with the same
// config and the phone usually rejoins by itself.
static bool apply_sta_mac(const uint8_t mac[6])
{
    wifi_mode_t m = WIFI_MODE_NULL;
    esp_wifi_get_mode(&m);
    if (m == WIFI_MODE_NULL) return esp_iface_mac_addr_set(mac, ESP_MAC_WIFI_STA) == ESP_OK; // driver off
    WiFi.disconnect(false);
    esp_wifi_stop();
    if (!(m & WIFI_MODE_STA)) esp_wifi_set_mode(WIFI_MODE_APSTA);
    esp_err_t e = esp_wifi_set_mac(WIFI_IF_STA, mac);
    esp_wifi_set_mode(m);
    esp_wifi_start();
    Serial.printf("[net] set STA MAC: %s\n", esp_err_to_name(e));
    if (e == ESP_OK) esp_iface_mac_addr_set(mac, ESP_MAC_WIFI_STA); // what esp_read_mac reports
    return e == ESP_OK;
}

static void handle_mac()
{
    uint8_t mac[6], ap[6];
    bool factory = server.hasArg("factory");
    if (factory) esp_efuse_mac_get_default(mac);
    esp_read_mac(ap, ESP_MAC_WIFI_SOFTAP);
    bool ok = factory || parse_mac(server.arg("m"), mac);
    if (!ok) set_msg("Invalid MAC: use aa:bb:cc:dd:ee:ff, first byte even (unicast).", true);
    else if (!memcmp(mac, ap, 6)) { ok = false; set_msg("That MAC belongs to the setup network, choose another.", true); }

    // reply first: applying restarts the radio, the phone drops off the AP for a moment
    server.sendHeader("Location", "/", true);
    server.send(303, "text/plain", "");
    if (!ok) return;
    delay(100);

    if (factory) prefs.remove("mac"); else prefs.putBytes("mac", mac, 6);
    if (apply_sta_mac(mac)) {
        mac_custom = !factory;
        set_msg("MAC in use: " + net_mac() + (factory ? " (factory)" : " (custom)"));
    } else { // driver refused: the saved MAC is applied at boot
        set_msg("MAC saved, rebooting to apply...");
        schedule_reboot(REBOOT_WARN_MS, "APPLYING NEW MAC");
    }
}

static void make_ap_identity()
{
    uint8_t mac[6];
    esp_efuse_mac_get_default(mac); // factory MAC: the id stays the same with a custom STA MAC
    strlcpy(ap_ssid, "workdesk", sizeof ap_ssid);                        // name people see
    // dev_id keeps the MAC suffix: unique X-Device-Id for the backend
    snprintf(dev_id, sizeof dev_id, "workdesk-%02x%02x", mac[4], mac[5]);

    String p = prefs.getString("ap_pass", "");
    if (p.length() != 8) {
        static const char ABC[] = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
        p = "";
        for (int i = 0; i < 8; i++) p += ABC[esp_random() % (sizeof ABC - 1)];
        prefs.putString("ap_pass", p);
    }
    strlcpy(ap_pass, p.c_str(), sizeof ap_pass);
}

void net_start_portal()
{
    if (state == NET_PORTAL) return;
    WiFi.disconnect(false);
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(false); // the STA side only tries what the form sends
    portal_scan();                // before the AP exists, so no client is disturbed

    WiFi.mode(WIFI_AP_STA);
    WiFi.setSleep(false);         // AP stays responsive
    make_ap_identity();
    ap_ch = portal_channel();
    WiFi.softAP(ap_ssid, ap_pass, ap_ch);
    dns.start(53, "*", WiFi.softAPIP());
    Serial.printf("[net] portal AP %s on ch %d\n", ap_ssid, ap_ch);

    static bool routes = false;
    if (!routes) {
        routes = true;
        server.on("/", HTTP_GET, handle_root);
        server.on("/scan", HTTP_GET, handle_scan);
        server.on("/f400.woff2", HTTP_GET, [] { send_font(web_jbm_400, web_jbm_400_len); });
        server.on("/f700.woff2", HTTP_GET, [] { send_font(web_jbm_700, web_jbm_700_len); });
        server.on("/save", HTTP_POST, handle_save);
        server.on("/forget", HTTP_POST, handle_forget);
        server.on("/token", HTTP_POST, handle_token);
        server.on("/mac", HTTP_POST, handle_mac);
        server.onNotFound(handle_redirect); // captive-portal checks (generate_204, hotspot-detect, ...)
    }
    server.begin();

    joining = false;
    done_at = 0;
    join_ssid = "";
    portal_auto = false;
    portal_at = millis();
    state = NET_PORTAL;
    set_msg("Waiting for your phone...");
}

void net_stop_portal()
{
    if (state != NET_PORTAL) return;
    server.stop();
    dns.stop();
    WiFi.softAPdisconnect(true);
    WiFi.setSleep(true);
    joining = false;
    done_at = 0;
    if (WiFi.status() == WL_CONNECTED) { // joined from the portal: keep that connection
        WiFi.mode(WIFI_STA);
        state = NET_CONNECTED;
        start_ntp();
    } else if (net_has_creds()) {
        cycle_start();
    } else {
        WiFi.mode(WIFI_OFF);
        state = NET_OFF;
    }
}

static void portal_loop()
{
    dns.processNextRequest();
    server.handleClient();

    if (portal_auto && !joining && !done_at && WiFi.softAPgetStationNum() == 0 &&
        millis() - portal_at > AUTO_PORTAL_IDLE_MS) {
        Serial.println("[net] auto portal idle -> retry saved networks");
        failed_rounds = 0; // one more round, then the portal again (boot only)
        net_stop_portal();
        return;
    }

    if (done_at) {
        if (millis() - done_at > PORTAL_DONE_MS) net_stop_portal();
        return;
    }
    if (!joining) return;

    if (!join_sent) {
        if (millis() - join_at < join_wait) return;
        const seen_t *sn = seen_find(join_ssid);
        wifi_join(join_ssid, join_pass, sn ? sn->ch : 0, sn ? sn->bssid : nullptr);
        join_sent = true;
        join_at = millis();
        return;
    }

    wl_status_t st = WiFi.status();
    uint32_t dt = millis() - join_at;
    if (st == WL_CONNECTED) {
        joining = false;
        Serial.printf("[net] portal join took %u ms (ch %d)\n", (unsigned)dt, WiFi.channel());
        nets_connected(join_ssid, join_pass);
        ever_connected = true;
        failed_rounds = 0;
        set_msg("Connected! " + WiFi.localIP().toString());
        done_at = millis();
    } else if (join_failed() && disc_reason == WIFI_REASON_AUTH_FAIL && !join_retried) {
        // WPA2/WPA3 routers reject the first join after the radio starts (see try_next): retry once
        Serial.printf("[net] portal join: AUTH_FAIL after %u ms, retrying once\n", (unsigned)dt);
        WiFi.disconnect(false);
        join_retried = true;
        join_sent = false;
        join_wait = RETRY_GAP_MS;
        join_at = millis();
    } else if (join_failed() || dt > JOIN_TIMEOUT_MS) {
        joining = false;
        uint8_t r = join_failed() ? disc_reason : 0;
        fail_text_t why = fail_text(r);
        const seen_t *sn = seen_find(join_ssid);
        Serial.printf("[net] portal join failed: reason %d (%s), auth %d, ch %d, %u ms\n", disc_reason,
                      WiFi.disconnectReasonName((wifi_err_reason_t)disc_reason), sn ? sn->auth : -1,
                      sn ? sn->ch : -1, (unsigned)dt);
        WiFi.disconnect(false);
        String hint = why.hint;
        if (sn && sn->rssi < -80 && r != WIFI_REASON_AUTH_FAIL)
            hint += " Signal here is weak (" + String(sn->rssi) + " dBm).";
        hint += " [code " + String(r) + "]"; // for support / logs
        set_msg(join_ssid + ": " + why.title, true, hint);
    }
}

// ---- public -----------------------------------------------------------------
void net_begin()
{
    WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t info) {
        disc_reason = info.wifi_sta_disconnected.reason;
        disc_count = disc_count + 1;
    }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
    WiFi.persistent(false); // we keep credentials ourselves; skip the driver's flash write on every begin()
    prefs.begin("net", false);
    uint8_t mac[6];
    if (prefs.getBytes("mac", mac, 6) == 6) { // must happen before the Wi-Fi driver starts
        esp_err_t e = esp_iface_mac_addr_set(mac, ESP_MAC_WIFI_STA);
        mac_custom = e == ESP_OK;
        Serial.printf("[net] custom MAC %02x:%02x:%02x:%02x:%02x:%02x: %s\n", mac[0], mac[1], mac[2],
                      mac[3], mac[4], mac[5], esp_err_to_name(e));
    }
    make_ap_identity();
    cfg_mux = xSemaphoreCreateMutex();
    api_token = prefs.getString("api_token", "");
    api_url = prefs.getString("api_url", "");
    nets_load();
    Serial.printf("[net] %d saved network(s)\n", n_nets);
    for (int i = 0; i < n_nets; i++) Serial.printf("  %d: %s (ch %d, pass len %u)\n", i, nets[i].ssid.c_str(), nets[i].ch, nets[i].pass.length());
    if (net_has_creds()) {
        cycle_start();
    } else {
        Serial.println("[net] no saved Wi-Fi -> setup portal");
        net_start_portal();
    }
}

void net_loop()
{
    if (reboot_at && (int32_t)(millis() - reboot_at) >= 0) {
        Serial.printf("[net] rebooting: %s\n", reboot_why);
        Serial.flush();
        ESP.restart();
    }
    switch (state) {
    case NET_PORTAL:
        portal_loop();
        break;
    case NET_CONNECTING:
        connect_loop();
        break;
    case NET_CONNECTED:
        if (WiFi.status() != WL_CONNECTED) {
            Serial.println("[net] lost connection");
            cycle_start();
            break;
        }
        start_ota();
        ArduinoOTA.handle();
        break;
    default:
        break;
    }
}

bool net_has_creds() { return n_nets > 0; }
String net_device_id() { return dev_id; }
String net_api_token()
{
    xSemaphoreTake(cfg_mux, portMAX_DELAY);
    String t = api_token;
    xSemaphoreGive(cfg_mux);
    return t;
}

String net_api_url()
{
    xSemaphoreTake(cfg_mux, portMAX_DELAY);
    String u = api_url;
    xSemaphoreGive(cfg_mux);
    return u;
}

String net_api_key_hint()
{
    String t = net_api_token();
    return t.length() > 8 ? t.substring(0, 8) + "..." : t.length() ? String("(set)") : String();
}

bool net_set_backend(const char *url, const char *key, String *err)
{
    String u = url ? url : "", k = key ? key : "";
    u.trim();
    k.trim();
    while (u.endsWith("/")) u.remove(u.length() - 1);
    if (url && u.length() && !u.startsWith("https://") && !u.startsWith("http://")) {
        if (err) *err = "URL must start with https:// (or http:// for a local test).";
        return false;
    }
    if (u.length() > 128 || k.length() > 128) {
        if (err) *err = "URL or key is too long.";
        return false;
    }
    xSemaphoreTake(cfg_mux, portMAX_DELAY);
    if (url) { api_url = u; if (u.length()) prefs.putString("api_url", u); else prefs.remove("api_url"); }
    if (!url && !k.length()) { api_token = ""; prefs.remove("api_token"); } // clear the key
    else if (k.length()) { api_token = k; prefs.putString("api_token", k); }   // empty key = keep
    xSemaphoreGive(cfg_mux);
    Serial.printf("[net] backend: %s, key %s\n", u.length() ? u.c_str() : "(none)", net_api_key_hint().c_str());
    return true;
}
bool net_mac_custom() { return mac_custom; }
bool net_portal_busy() { return state == NET_PORTAL && (joining || done_at); }
bool net_booting() { return !ever_connected && state == NET_CONNECTING; }
const char *net_status() { return status; }
String net_mac()
{
    uint8_t m[6];
    if (esp_wifi_get_mac(WIFI_IF_STA, m) != ESP_OK) // driver running: what the radio uses
        esp_read_mac(m, ESP_MAC_WIFI_STA);          // else the configured one (custom or factory)
    char b[18];
    snprintf(b, sizeof b, "%02x:%02x:%02x:%02x:%02x:%02x", m[0], m[1], m[2], m[3], m[4], m[5]);
    return b;
}
void net_on_ota(void (*cb)(int)) { ota_cb = cb; }
void net_ota_report(int pct)
{
    static int last = -2;
    if (pct == last) return;
    last = pct;
    if (ota_cb) ota_cb(pct);
    if (pct == 100) {
        Serial.println("[ota] done");
        schedule_reboot(REBOOT_WARN_MS, "UPDATE INSTALLED");
    }
    if (pct >= 100 || pct < 0) last = -2;
}
int net_reboot_in()
{
    if (!reboot_at) return -1;
    int32_t left = (int32_t)(reboot_at - millis());
    return left > 0 ? (left + 999) / 1000 : 0;
}
const char *net_reboot_reason() { return reboot_why; }
net_state_t net_state() { return state; }
int net_rssi() { return state == NET_CONNECTED ? WiFi.RSSI() : 0; }
bool net_time_synced() { return time_synced; }
const char *net_ap_ssid() { return ap_ssid; }
const char *net_ap_pass() { return ap_pass; }
const char *net_portal_url() { return "192.168.4.1"; }
const char *net_portal_msg() { return msg.c_str(); }
bool net_portal_msg_error() { return msg_err; }
uint32_t net_portal_rev() { return msg_rev; }
