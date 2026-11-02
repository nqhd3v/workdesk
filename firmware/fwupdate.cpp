// fwupdate.cpp — downloads a new release from the public workdesk repo (see release.sh) once Workdesk
// reports one, and installs it when BOOT is pressed. latest.json = {"version":"1.2.3","sha256":"..."}, latest.sig = hex ECDSA P-256 signature
// of latest.json, checked with FW_PUBKEY before anything in it is trusted. The signed SHA-256 ties the
// image to the manifest and the signed version keeps an old release from being replayed, so a changed
// repo can't install anything release.sh didn't sign. Runs on the API task between sync rounds: there
// is internal RAM for one TLS session at a time. The web server stays up meanwhile.
#include "fwupdate.h"
#include "fw_pubkey.h"
#include "net.h"
#include <HTTPClient.h>
#include <NetworkClientSecure.h>
#include <ArduinoJson.h>
#include <Update.h>
#include <SHA2Builder.h>
#include <HEXBuilder.h>
#include <esp_ota_ops.h>

#define RELEASE_URL "https://raw.githubusercontent.com/nqhd3v/workdesk/main/firmware/"
#define HTTP_TIMEOUT 15000
#define RETRY_MS (10 * 60 * 1000UL) // after a failure; raw.githubusercontent.com also caches for minutes

extern const uint8_t ca_bundle_start[] asm("_binary_x509_crt_bundle_start");
extern const uint8_t ca_bundle_end[] asm("_binary_x509_crt_bundle_end");

static const char *current = "";
static char offered[16] = "";                          // newest version Workdesk reported
static char ready[16] = "";                            // downloaded and verified
static const esp_partition_t *volatile staged = nullptr; // where `ready` waits, set once it's safe to boot
static uint32_t retry_at = 0;
static volatile bool busy = false;
static String msg;
static SemaphoreHandle_t mux;

static void set_msg(const String &m)
{
    xSemaphoreTake(mux, portMAX_DELAY);
    msg = m;
    xSemaphoreGive(mux);
}

static bool is_newer(const char *latest, const char *installed)
{
    int a[3] = {}, b[3] = {};
    sscanf(latest, "%d.%d.%d", &a[0], &a[1], &a[2]);
    sscanf(installed, "%d.%d.%d", &b[0], &b[1], &b[2]);
    for (int i = 0; i < 3; i++)
        if (a[i] != b[i]) return a[i] > b[i];
    return false;
}

static int fetch(NetworkClientSecure &tls, const char *name, String &out)
{
    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT);
    int code = http.begin(tls, String(RELEASE_URL) + name) ? http.GET() : -1;
    out = code == 200 ? http.getString() : "";
    http.end();
    return code;
}

static bool signature_ok(const String &manifest, String sig_hex)
{
    uint8_t sig[128]; // DER P-256 is at most 72
    sig_hex.trim();
    size_t len = sig_hex.length() / 2;
    if (!len || len > sizeof sig || HEXBuilder::hex2bytes(sig, len, sig_hex) != len) return false;

    SHA256Builder sha;
    sha.begin();
    sha.add((const uint8_t *)manifest.c_str(), manifest.length());
    sha.calculate();
    UpdaterECDSAVerifier key((const uint8_t *)FW_PUBKEY, sizeof FW_PUBKEY, HASH_SHA256);
    return key.verify(&sha, sig, len);
}

// Stores the image in the idle app slot. Update.end() also makes it the boot slot, which would install
// it on the next power cut, so the running slot goes straight back until fwupdate_install().
static String download(NetworkClientSecure &tls, const char *version, const char *sha256)
{
    const esp_partition_t *slot = esp_ota_get_next_update_partition(nullptr);
    if (!slot) return "no update slot";

    HTTPClient http;
    http.setTimeout(HTTP_TIMEOUT);
    if (!http.begin(tls, RELEASE_URL "desk-bomb.bin")) return "bad URL";
    int code = http.GET();
    int size = http.getSize();
    if (code != 200 || size <= 0) { http.end(); return "download returned " + String(code); }

    staged = nullptr; // the slot is about to be overwritten
    ready[0] = 0;
    if (!Update.begin(size, U_FLASH)) { http.end(); return Update.errorString(); }
    if (!Update.setSHA256(sha256)) { http.end(); Update.abort(); return "bad sha256"; }
    static String label;
    label = String("Downloading ") + version;
    Update.onProgress([](size_t done, size_t total) { set_msg(label + ": " + (total ? done * 100 / total : 0) + "%"); });
    size_t written = Update.writeStream(*http.getStreamPtr());
    http.end();
    if (written != (size_t)size) { Update.abort(); return "download cut off"; }
    if (!Update.end()) return Update.errorString(); // includes the SHA-256 check
    if (esp_ota_set_boot_partition(esp_ota_get_running_partition()) != ESP_OK) return "can't keep the running slot";

    strlcpy(ready, version, sizeof ready);
    staged = slot;
    return "";
}

static bool check_and_download()
{
    NetworkClientSecure tls;
    tls.setCACertBundle(ca_bundle_start, ca_bundle_end - ca_bundle_start);

    String body, sig;
    int code = fetch(tls, "latest.json", body);
    int sig_code = code == 200 ? fetch(tls, "latest.sig", sig) : code;

    JsonDocument doc;
    if (code != 200 || sig_code != 200) {
        set_msg("Check failed: " + String(code == 200 ? sig_code : code));
    } else if (!signature_ok(body, sig)) {
        Serial.println("[ota] latest.json signature rejected");
        set_msg("Check failed: bad signature");
    } else if (deserializeJson(doc, body) || !doc["version"].is<const char *>() || !doc["sha256"].is<const char *>()) {
        set_msg("Check failed: bad latest.json");
    } else if (!is_newer(doc["version"], ready[0] ? ready : current)) {
        set_msg(String("Waiting for ") + offered + " (latest.json still has " + doc["version"].as<const char *>() + ")");
    } else {
        String err = download(tls, doc["version"], doc["sha256"]);
        if (!err.length()) {
            Serial.printf("[ota] %s ready, press BOOT\n", ready);
            set_msg(String(ready) + " ready: press BOOT on the module");
            return true;
        }
        Serial.printf("[ota] github download failed: %s\n", err.c_str());
        set_msg("Download failed: " + err);
    }
    return false;
}

void fwupdate_begin(const char *fw_version)
{
    current = fw_version;
    mux = xSemaphoreCreateMutex();
}

void fwupdate_offer(const char *version)
{
    if (version && is_newer(version, current)) strlcpy(offered, version, sizeof offered);
}

void fwupdate_poll()
{
    if (!offered[0] || !strcmp(offered, ready) || Update.isRunning() || net_state() != NET_CONNECTED) return;
    if (retry_at && (int32_t)(millis() - retry_at) < 0) return;
    busy = true;
    retry_at = check_and_download() ? 0 : (millis() + RETRY_MS) | 1;
    busy = false;
}

const char *fwupdate_ready() { return staged ? ready : ""; }

bool fwupdate_install()
{
    if (!staged || esp_ota_set_boot_partition(staged) != ESP_OK) return false;
    net_ota_report(100);
    return true;
}

bool fwupdate_busy() { return busy; }

String fwupdate_msg()
{
    xSemaphoreTake(mux, portMAX_DELAY);
    String m = msg;
    xSemaphoreGive(mux);
    return m;
}
