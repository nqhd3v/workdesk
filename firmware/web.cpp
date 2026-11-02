// web.cpp — local web page (dashboard + settings) while connected to a network.
//   GET  /               login page, or once signed in the page (polls /api/status every 2 s)
//                        ?code=<login code> (the QR on the code page): the login page posts it itself
//   POST /api/login      code=<login code>: sets the session cookie
//   GET  /api/status     live JSON
//   POST /api/settings   JSON with any settings fields, returns the full settings
//   POST /api/backend    {"url","key"}: Workdesk base URL + module API key (NVS)
//   POST /update         firmware upload (multipart, field "firmware"), then reboot after the warning:
//                        curl -u admin:<code> -F firmware=@firmware.ino.bin http://workdesk.local/update
// BOOT shows a one-time code on the screen. It buys a browser session, or one curl request as the
// Basic auth password, so logging in takes physical access. Fonts are public. Plain HTTP on the
// LAN: keeps casual visitors out, not a determined attacker.
#include "web.h"
#include "net.h"
#include "api.h"
#include "settings.h"
#include "logq.h"
#include "fwupdate.h"
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <esp_random.h>

extern "C" const uint8_t web_jbm_400[], web_jbm_700[];  // web_font.c
extern "C" const size_t web_jbm_400_len, web_jbm_700_len;

// The stock server takes connections strictly in order and waits 5 s on each. Chrome opens a spare
// connection and sends nothing on it, so its real request sat behind that one and failed. Hold every
// connection here instead, and serve whichever has sent something.
class DeskServer : public WebServer {
public:
    using WebServer::WebServer;

    void serve()
    {
        for (NetworkClient &c : parked)
            if (c && !c.connected()) c.stop(); // free the rx buffer of a closed socket
        while (_server.hasClient()) {
            NetworkClient c = _server.accept();
            int slot = 0;
            while (slot < SPARE && parked[slot].connected()) slot++;
            if (slot == SPARE) { slot = oldest; oldest = (oldest + 1) % SPARE; }
            parked[slot] = c;
        }
        if (_currentStatus == HC_NONE) {
            for (NetworkClient &c : parked) {
                if (!c.connected() || !c.available()) continue;
                _currentClient = c;
                c = NetworkClient();
                _currentStatus = HC_WAIT_READ;
                _statusChange = millis();
                break;
            }
        }
        handleClient();
    }

private:
    static const int SPARE = 4;
    NetworkClient parked[SPARE];
    int oldest = 0;
};

static DeskServer server(80);
static bool running = false, mdns_added = false;
static const char *fw = "";
static web_live_t live = { NAN, NAN, NAN, 0, -1, 0, NAN, NAN, 0, -1, "unknown", true };

#define CODE_LEN       6
#define CODE_TTL_MS    60000
#define CODE_MAX_TRIES 5
#define SESSION_TTL_MS (60 * 60 * 1000UL)  // lost on reboot
#define SESSION_COOKIE "workdesk_session"

// No 0/O, 1/I/L: read off a small screen.
static const char CODE_CHARS[] = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

static char code[CODE_LEN + 1] = "";
static uint32_t code_at = 0;
static int code_tries = 0;
static char session[33] = "";  // one signed-in browser at a time
static uint32_t session_at = 0;

void web_code_new()
{
    for (int i = 0; i < CODE_LEN; i++) code[i] = CODE_CHARS[esp_random() % (sizeof CODE_CHARS - 1)];
    code[CODE_LEN] = 0;
    code_at = millis();
    code_tries = 0;
}

void web_code_clear() { code[0] = 0; }
const char *web_code() { return code; }

int web_code_left()
{
    if (!code[0]) return 0;
    uint32_t age = millis() - code_at;
    if (age >= CODE_TTL_MS) { web_code_clear(); return 0; }
    return (CODE_TTL_MS - age + 999) / 1000;
}

// Single use, and a few wrong tries burn the code. Returns ok.
static bool code_result(bool ok)
{
    if (ok || ++code_tries >= CODE_MAX_TRIES) web_code_clear();
    return ok;
}

static bool session_ok()
{
    if (!session[0] || millis() - session_at >= SESSION_TTL_MS) return false;
    return server.header("Cookie").indexOf(String(SESSION_COOKIE "=") + session) >= 0;
}

static bool code_in_basic_auth()
{
    return web_code_left() && server.hasHeader("Authorization") && code_result(server.authenticate("admin", code));
}

static void deny() { server.send(401, "text/plain", "press BOOT and log in with the code on the screen\n"); }

static bool auth()
{
    if (session_ok() || code_in_basic_auth()) return true;
    deny();
    return false;
}

static void handle_login()
{
    String entered = server.arg("code");
    entered.trim();
    entered.toUpperCase();
    if (!web_code_left() || !code_result(entered == code)) { deny(); return; }

    snprintf(session, sizeof session, "%08lx%08lx%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random(),
             (unsigned long)esp_random(), (unsigned long)esp_random());
    session_at = millis();
    server.sendHeader("Set-Cookie", String(SESSION_COOKIE "=") + session + "; Path=/; Max-Age=" + (SESSION_TTL_MS / 1000) +
                                        "; HttpOnly; SameSite=Strict");
    server.send(204);
}

static void settings_json(JsonObject o)
{
    const settings_t &s = settings();
    o["brightness"] = s.brightness;
    o["mode"] = mode_name(s.mode);
    o["temp_offset"] = serialized(String(s.temp_offset, 1));
    o["night_off"] = s.night_off;
    char t[6];
    snprintf(t, sizeof t, "%02d:%02d", s.night_start / 60, s.night_start % 60);
    o["night_start"] = t;
    snprintf(t, sizeof t, "%02d:%02d", s.night_end / 60, s.night_end % 60);
    o["night_end"] = t;
}

static void send_json(JsonDocument &doc)
{
    String out;
    serializeJson(doc, out);
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "application/json", out);
}

static void handle_status()
{
    if (!auth()) return;
    JsonDocument doc;
    JsonObject d = doc["device"].to<JsonObject>();
    d["id"] = net_device_id();
    d["fw"] = fw;
    d["uptime_s"] = (uint32_t)(millis() / 1000);
    d["log_batches"] = logq_pending_files(); // readings waiting for upload
    static const char *RESET[] = { "unknown", "power_on", "ext", "sw", "panic", "int_wdt", "task_wdt", "wdt",
                                   "deep_sleep", "brownout", "sdio", "usb", "jtag", "efuse", "pwr_glitch", "cpu_lockup" };
    int rr = (int)esp_reset_reason();
    d["reset"] = rr >= 0 && rr < (int)(sizeof RESET / sizeof *RESET) ? RESET[rr] : "?"; // why the last boot happened
    d["ip"] = WiFi.localIP().toString();
    d["ssid"] = WiFi.SSID();
    d["rssi"] = WiFi.RSSI();
    d["mac"] = net_mac();
    d["heap_kb"] = ESP.getFreeHeap() / 1024;
    d["screen_on"] = live.screen_on;

    JsonObject e = doc["env"].to<JsonObject>();
    if (isnan(live.temp_c)) e["temp_c"] = nullptr; else e["temp_c"] = serialized(String(live.temp_c, 1));
    if (isnan(live.hum_pct)) e["hum_pct"] = nullptr; else e["hum_pct"] = serialized(String(live.hum_pct, 0));
    if (isnan(live.pressure_hpa)) e["pressure_hpa"] = nullptr; else e["pressure_hpa"] = serialized(String(live.pressure_hpa, 1));
    if (live.gas_ohm) e["gas_ohm"] = live.gas_ohm; else e["gas_ohm"] = nullptr;
    if (live.iaq < 0) e["iaq"] = nullptr; else e["iaq"] = live.iaq;
    e["iaq_acc"] = live.iaq_acc;
    if (isnan(live.co2_eq)) e["co2_ppm"] = nullptr; else e["co2_ppm"] = (int)lroundf(live.co2_eq);
    if (isnan(live.lux)) e["lux"] = nullptr; else e["lux"] = (int)lroundf(live.lux);

    JsonObject p = doc["power"].to<JsonObject>();
    p["source"] = live.power;
    p["batt_mv"] = live.batt_mv;
    if (live.batt_pct >= 0) p["batt_pct"] = live.batt_pct; else p["batt_pct"] = nullptr;

    int code;
    time_t at, next;
    api_last(&code, &at, &next);
    JsonObject a = doc["api"].to<JsonObject>();
    a["last_code"] = code;
    a["last_at"] = (uint32_t)at;
    a["next_at"] = (uint32_t)next;
    a["url"] = net_api_url();
    a["key"] = net_api_key_hint(); // prefix only, never the key
    static api_data_t ad; // static: big (meetings)
    api_get(&ad);
    auto usage = [&](const char *name, const api_usage_t &u) {
        if (!u.seen) { a[name] = nullptr; return; }
        JsonObject o = a[name].to<JsonObject>();
        o["present"] = u.present;
        o["session_pct"] = u.session_pct;
        o["week_pct"] = u.week_pct;
        o["month_pct"] = u.month_pct;
        o["measured_at"] = (uint32_t)u.measured_at;
    };
    usage("claude", ad.claude);
    usage("copilot", ad.copilot);
    a["fetched_at"] = (uint32_t)ad.fetched_at;
    a["events"] = ad.n_meetings;

    JsonObject u = doc["update"].to<JsonObject>();
    u["msg"] = fwupdate_msg();

    settings_json(doc["settings"].to<JsonObject>());
    send_json(doc);
}

static uint16_t parse_hhmm(const char *t, uint16_t fallback)
{
    int h, m;
    if (t && sscanf(t, "%d:%d", &h, &m) == 2 && h >= 0 && h < 24 && m >= 0 && m < 60) return h * 60 + m;
    return fallback;
}

static void handle_settings()
{
    if (!auth()) return;
    JsonDocument in;
    if (deserializeJson(in, server.arg("plain"))) {
        server.send(400, "text/plain", "bad JSON");
        return;
    }
    settings_t s = settings();
    if (in["brightness"].is<int>()) s.brightness = in["brightness"].as<int>();
    if (in["mode"].is<const char *>()) s.mode = strcmp(in["mode"], "save_battery") == 0 ? MODE_SAVE_BATTERY : MODE_NORMAL;
    if (in["temp_offset"].is<float>()) s.temp_offset = in["temp_offset"].as<float>();
    if (in["night_off"].is<bool>()) s.night_off = in["night_off"].as<bool>();
    if (in["night_start"].is<const char *>()) s.night_start = parse_hhmm(in["night_start"], s.night_start);
    if (in["night_end"].is<const char *>()) s.night_end = parse_hhmm(in["night_end"], s.night_end);
    settings_set(s);
    Serial.printf("[web] settings: bright %d, mode %s, offset %.1f, night %d %d-%d\n", s.brightness,
                  mode_name(settings().mode), settings().temp_offset, settings().night_off,
                  settings().night_start, settings().night_end);
    JsonDocument doc;
    settings_json(doc.to<JsonObject>());
    send_json(doc);
}

// {"url": "https://...", "key": "wdk_..."}: either may be left out (kept). Same rules as the portal.
static void handle_backend()
{
    if (!auth()) return;
    JsonDocument in;
    if (deserializeJson(in, server.arg("plain"))) {
        server.send(400, "text/plain", "bad JSON");
        return;
    }
    String err;
    if (!net_set_backend(in["url"].is<const char *>() ? in["url"].as<const char *>() : nullptr,
                         in["key"] | "", &err)) {
        server.send(422, "text/plain", err + "\n");
        return;
    }
    JsonDocument doc;
    doc["url"] = net_api_url();
    doc["key"] = net_api_key_hint();
    send_json(doc);
}

static void send_font(const uint8_t *data, size_t len)
{
    server.sendHeader("Cache-Control", "public, max-age=31536000, immutable");
    server.send_P(200, "font/woff2", (const char *)data, len);
}

static const char PAGE[] PROGMEM = R"HTML(<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>workdesk</title><style>
@font-face{font-family:JBM;src:url(/f400.woff2) format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:JBM;src:url(/f700.woff2) format('woff2');font-weight:700;font-display:swap}
*{box-sizing:border-box}
body{font:15px JBM,ui-monospace,monospace;background:#000;color:#f2f2f2;max-width:560px;margin:auto;padding:24px 18px}
h1{color:#f5a524;font-size:18px;letter-spacing:1px;margin:0}
.sub{color:#8a8a8a;font-size:13px;margin:4px 0 24px}
h3{color:#8a8a8a;font-size:13px;font-weight:400;letter-spacing:1px;margin:28px 0 10px}
.g{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.c{border:1px solid #262626;border-radius:10px;padding:12px 14px}
.k{color:#8a8a8a;font-size:12px;letter-spacing:1px}
.v{font-size:26px;font-weight:700;margin-top:4px}.v small{font-size:14px;color:#8a8a8a;font-weight:400}
.s{color:#8a8a8a;font-size:12px;margin-top:2px}
.row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid #262626}
.row label{color:#f2f2f2}
input[type=range]{width:55%;accent-color:#f5a524}
input[type=time],input[type=number]{font:inherit;background:#000;color:#f2f2f2;border:1px solid #3a3a3a;border-radius:8px;padding:8px;width:110px}
.seg{display:flex;border:1px solid #3a3a3a;border-radius:8px;overflow:hidden}
.seg input{display:none}.seg label{padding:8px 12px;cursor:pointer;color:#8a8a8a}
.seg input:checked+label{background:#f5a524;color:#000;font-weight:700}
button{font:inherit;background:none;color:#f5a524;border:1px solid #f5a524;border-radius:8px;padding:8px 12px;cursor:pointer}
button:disabled{color:#8a8a8a;border-color:#3a3a3a;cursor:default}
input[type=checkbox]{width:20px;height:20px;accent-color:#f5a524}
#t{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:#111;border:1px solid #3a3a3a;
border-radius:8px;padding:8px 14px;color:#4fd1e8;opacity:0;transition:opacity .3s}
.cy{color:#4fd1e8}.gr{color:#3ddc84}.am{color:#f5a524}
</style></head><body>
<h1>WORKDESK</h1><div class=sub id=sub>...</div>
<div class=g>
<div class=c id=tempc><div class=k>TEMP</div><div class=v id=temp>--</div><div class=s id=pres></div></div>
<div class=c id=humc><div class=k>HUMIDITY</div><div class="v cy" id=hum>--</div><div class=s id=gas></div></div>
<div class=c id=luxc><div class=k>LIGHT</div><div class=v id=lux>--</div></div>
<div class=c><div class=k>BATTERY</div><div class="v gr" id=bat>--</div><div class=s id=batmv></div></div>
<div class=c><div class=k>WI-FI</div><div class=v id=rssi>--</div><div class=s id=ssid></div></div>
</div>
<h3>DISPLAY</h3>
<div class=row><label for=br>Brightness</label><span id=brv class=am></span><input type=range id=br min=5 max=100></div>
<div class=row><span>Mode</span><div class=seg>
<input type=radio name=mode id=m0 value=normal><label for=m0>NORMAL</label>
<input type=radio name=mode id=m1 value=save_battery><label for=m1>SAVE BATTERY</label></div></div>
<div class=row><label for=no>Screen off at night</label><input type=checkbox id=no></div>
<div class=row><span>From / to</span><span><input type=time id=ns> <input type=time id=ne></span></div>
<h3>SENSOR</h3>
<div class=row><label for=to>Temperature offset (&deg;C)</label><input type=number id=to step=0.1 min=-10 max=10></div>
<h3>FIRMWARE</h3>
<div class=row><span id=fw>--</span></div><div class=s id=updm></div>
<h3>DEVICE</h3><div class=s id=dev></div>
<div id=t>Saved</div>
<script>
const $=id=>document.getElementById(id);let loaded=false;
function toast(m){$('t').textContent=m;$('t').style.opacity=1;setTimeout(()=>$('t').style.opacity=0,1200)}
function up(n){const h=Math.floor(n/3600),m=Math.floor(n/60)%60;return (h>23?Math.floor(h/24)+'d ':'')+(h%24)+'h '+m+'m'}
function fill(s){$('br').value=s.brightness;$('brv').textContent=s.brightness+'%'+(s.mode=='save_battery'&&s.brightness>30?' (max 30)':'');
$(s.mode=='save_battery'?'m1':'m0').checked=true;$('no').checked=s.night_off;$('ns').value=s.night_start;$('ne').value=s.night_end;
$('to').value=s.temp_offset}
async function poll(){try{const r=await fetch('/api/status');if(r.status==401)return location.reload();const d=await r.json();const e=d.env,p=d.power,v=d.device;
for(const[id,key]of[['tempc','temp_c'],['humc','hum_pct'],['luxc','lux']])$(id).style.display=e[key]==null?'none':'';
$('temp').innerHTML=e.temp_c==null?'--':e.temp_c+'<small> &deg;C</small>';
$('lux').innerHTML=e.lux==null?'--':e.lux+'<small> lx</small>';
$('hum').innerHTML=e.hum_pct==null?'--':e.hum_pct+'<small> %</small>';
$('pres').textContent=e.pressure_hpa==null?'':e.pressure_hpa+' hPa';
$('gas').textContent=e.iaq==null?(e.gas_ohm==null?'':'gas '+(e.gas_ohm/1000).toFixed(0)+' kΩ'):e.iaq_acc==0?'IAQ warming up':'IAQ '+e.iaq+(e.co2_ppm==null?'':' · CO₂ '+e.co2_ppm+' ppm')+(e.iaq_acc<3?' (calibrating)':'');
$('bat').innerHTML=p.source=='usb'?'USB':(p.batt_pct==null?'--':p.batt_pct+'<small> %</small>');
$('batmv').textContent=p.batt_mv+' mV · '+p.source;
$('rssi').innerHTML=v.rssi+'<small> dBm</small>';$('ssid').textContent=v.ssid+' · '+v.ip;
$('sub').textContent=v.id+' · up '+up(v.uptime_s)+(v.screen_on?'':' · screen off');
$('dev').innerHTML='MAC '+v.mac+'<br>Heap '+v.heap_kb+' KB<br>API '+(d.api.last_code||'not yet');
$('fw').textContent='Version '+v.fw;$('updm').textContent=d.update.msg;
if(!loaded){fill(d.settings);loaded=true}}catch(x){$('sub').textContent='offline, retrying...'}}
async function save(o){const r=await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});
if(r.status==401)return location.reload();if(r.ok){fill(await r.json());toast('Saved')}else toast('Error '+r.status)}
$('br').oninput=()=>$('brv').textContent=$('br').value+'%';
$('br').onchange=()=>save({brightness:+$('br').value});
document.querySelectorAll('[name=mode]').forEach(i=>i.onchange=()=>save({mode:i.value}));
$('no').onchange=()=>save({night_off:$('no').checked});
$('ns').onchange=()=>save({night_start:$('ns').value});$('ne').onchange=()=>save({night_end:$('ne').value});
$('to').onchange=()=>save({temp_offset:+$('to').value});
poll();setInterval(poll,2000);
</script></body></html>)HTML";

static const char LOGIN_PAGE[] PROGMEM = R"HTML(<!doctype html><html><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>workdesk</title><style>
@font-face{font-family:JBM;src:url(/f400.woff2) format('woff2');font-weight:400;font-display:swap}
@font-face{font-family:JBM;src:url(/f700.woff2) format('woff2');font-weight:700;font-display:swap}
*{box-sizing:border-box}
body{font:15px JBM,ui-monospace,monospace;background:#000;color:#f2f2f2;max-width:360px;margin:auto;padding:18vh 18px 24px}
h1{color:#f5a524;font-size:18px;letter-spacing:1px;margin:0}
p{color:#8a8a8a;font-size:13px;line-height:1.5;margin:6px 0 24px}
input,button{font:inherit;width:100%;border-radius:8px;padding:12px}
input{background:#000;color:#f2f2f2;border:1px solid #3a3a3a;font-size:26px;font-weight:700;letter-spacing:8px;text-align:center;text-transform:uppercase}
input:focus{outline:none;border-color:#f5a524}
button{background:#f5a524;color:#000;border:0;font-weight:700;margin-top:12px;cursor:pointer}
#e{color:#f5a524;font-size:13px;min-height:20px;margin-top:12px}
</style></head><body>
<h1>WORKDESK</h1><p>Press BOOT on the module, then enter the code on its screen.</p>
<form id=f><input id=c maxlength=6 required autofocus autocomplete=one-time-code autocapitalize=characters spellcheck=false aria-label=Code>
<button>Continue</button><div id=e role=alert></div></form>
<script>
f.onsubmit=async v=>{v.preventDefault();e.textContent='';
try{const r=await fetch('/api/login',{method:'POST',body:new URLSearchParams({code:c.value})});
if(r.ok)return location.reload();e.textContent='Wrong or expired code. Press BOOT for a new one.'}
catch(x){e.textContent='Module not reachable.'}c.select()}
const q=new URLSearchParams(location.search).get('code');
if(q){history.replaceState(null,'','/');c.value=q;f.requestSubmit()}
</script></body></html>)HTML";

static void handle_root()
{
    server.sendHeader("Cache-Control", "no-store");
    if (!session_ok()) server.send_P(200, "text/html", LOGIN_PAGE);
    else if (server.hasArg("code")) { // scanned while signed in: same as having used the code
        web_code_clear();
        server.sendHeader("Location", "/");
        server.send(302);
    } else server.send_P(200, "text/html", PAGE);
}

// Firmware upload. The upload callback runs (blocking loop()) before handle_update(); auth is
// checked on the first chunk so a stranger can't write to flash.
static bool upd_auth = false;
static String upd_err;
static size_t upd_total = 0;

static void handle_update_upload()
{
    HTTPUpload &u = server.upload();
    switch (u.status) {
    case UPLOAD_FILE_START:
        upd_err = "";
        upd_auth = session_ok() || code_in_basic_auth();
        if (!upd_auth) return;
        upd_total = server.clientContentLength();
        Serial.printf("[ota] http upload %s, ~%u bytes\n", u.filename.c_str(), (unsigned)upd_total);
        if (fwupdate_busy()) { upd_err = "a download is running, try again in a minute"; return; }
        net_ota_report(0);
        if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)) upd_err = Update.errorString();
        break;
    case UPLOAD_FILE_WRITE:
        if (!upd_auth || upd_err.length()) return;
        if (Update.write(u.buf, u.currentSize) != u.currentSize) upd_err = Update.errorString();
        else if (upd_total) net_ota_report(min<size_t>(99, u.totalSize * 100 / upd_total));
        break;
    case UPLOAD_FILE_END:
        if (!upd_auth) return;
        if (!upd_err.length() && !Update.end(true)) upd_err = Update.errorString(); // checks the image
        break;
    case UPLOAD_FILE_ABORTED:
        if (!upd_auth) return;
        if (!fwupdate_busy()) Update.abort();
        upd_err = "upload aborted";
        break;
    }
}

static void handle_update()
{
    if (!upd_auth) { deny(); return; }
    upd_auth = false;
    if (upd_err.length()) {
        Serial.printf("[ota] http upload failed: %s\n", upd_err.c_str());
        if (Update.isRunning() && !fwupdate_busy()) Update.abort();
        net_ota_report(-1);
        server.send(500, "text/plain", "update failed: " + upd_err + "\n");
        return;
    }
    server.send(200, "text/plain", "update installed, rebooting in " + String(REBOOT_WARN_MS / 1000) + " s\n");
    net_ota_report(100);
}

void web_begin(const char *fw_version) { fw = fw_version; }
void web_set_live(const web_live_t &l) { live = l; }

void web_loop()
{
    bool want = net_state() == NET_CONNECTED;
    if (want && !running) {
        static bool routes = false;
        if (!routes) {
            routes = true;
            static const char *headers[] = { "Cookie" };
            server.collectHeaders(headers, 1);
            server.on("/", HTTP_GET, handle_root);
            server.on("/api/login", HTTP_POST, handle_login);
            server.on("/api/status", HTTP_GET, handle_status);
            server.on("/api/settings", HTTP_POST, handle_settings);
            server.on("/update", HTTP_POST, handle_update, handle_update_upload);
            server.on("/api/backend", HTTP_POST, handle_backend);
            server.on("/f400.woff2", HTTP_GET, [] { send_font(web_jbm_400, web_jbm_400_len); });
            server.on("/f700.woff2", HTTP_GET, [] { send_font(web_jbm_700, web_jbm_700_len); });
        }
        server.begin();
        running = true;
        Serial.printf("[web] http://workdesk.local  http://%s\n", WiFi.localIP().toString().c_str());
    } else if (!want && running) {
        server.stop();
        running = false;
    }
    if (!running) return;
    if (!mdns_added) mdns_added = MDNS.addService("http", "tcp", 80); // once ArduinoOTA has started mDNS
    server.serve();
}
