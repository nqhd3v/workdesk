// logq.cpp — reading log + upload queue.
//
// SD layout (FAT, 1-bit SD_MMC):
//   /log/cur.csv        records being written (append + close every time: a power cut loses at
//                       most the line being written; a torn line is skipped when read)
//   /log/q/NNNNNNNN.csv closed batches waiting for upload, NNNNNNNN = increasing sequence
// cur.csv becomes the next batch when it holds SEG_MAX records (1 h), or when the uploader asks
// and nothing older is waiting (normal case: one small batch a minute). At boot a leftover
// cur.csv is queued first, so the new boot starts with an empty file.
// FIFO: more than LOG_MAX_FILES batches -> the oldest are deleted (1 h each -> 30 days).
//
// One CSV line per record:
//   ts,boot,up_s,temp_c,hum_pct,pressure_hpa,gas_ohm,iaq,iaq_acc,co2,voc,batt_mv,batt_pct,power,lux
// Empty field = no value. Lines from before lux have one field less.
//
// Without a card the same API runs on a RAM ring (RAM_MAX records, lost on power off).
//
// Records written before NTP have ts 0. When the clock syncs, the boot's start time is appended
// to /log/boots.csv ("bootid,epoch"), so ts = epoch + up_s works even after a power cut.
#include "logq.h"
#include <SD_MMC.h>
#include <esp_random.h>

#define SEG_MAX       120          // records per batch file (1 h at 30 s)
#define LOG_MAX_FILES (24 * 30)    // batches kept while offline
#define RAM_MAX       240          // 2 h at 30 s
#define CUR_PATH      "/log/cur.csv"
#define Q_DIR         "/log/q"
#define BOOTS_PATH    "/log/boots.csv"
#define BOOTS_MAX     32           // boot start times remembered

static SemaphoreHandle_t mux;
static bool sd = false;
static uint32_t boot_id = 0;

// SD state
static uint32_t q_head = 0, q_tail = 0; // oldest waiting / next free sequence
static int q_count = 0;
static int cur_lines = 0;
static uint32_t loaded_seq = UINT32_MAX;

// boot id -> Unix time at uptime 0
struct boot_t { uint32_t id, epoch; };
static boot_t boots[BOOTS_MAX];
static int n_boots = 0;
static bool time_saved = false;

static void boots_add(uint32_t id, uint32_t epoch)
{
    if (n_boots == BOOTS_MAX) { memmove(boots, boots + 1, (BOOTS_MAX - 1) * sizeof boots[0]); n_boots--; }
    boots[n_boots++] = { id, epoch };
}

// RAM fallback
static log_rec_t *ram = nullptr;
static int ram_head = 0, ram_n = 0, loaded_n = 0;

static void lock() { xSemaphoreTake(mux, portMAX_DELAY); }
static void unlock() { xSemaphoreGive(mux); }

static String q_path(uint32_t seq)
{
    char p[32];
    snprintf(p, sizeof p, Q_DIR "/%08lu.csv", (unsigned long)seq);
    return p;
}

// ---- CSV ----------------------------------------------------------------------
static void put_f(String &s, float v, int dec)
{
    if (!isnan(v)) s += String(v, dec);
    s += ',';
}

static String to_line(const log_rec_t &r)
{
    String s;
    s.reserve(104);
    s += String(r.ts) + ',' + String(r.boot, HEX) + ',' + String(r.up_s) + ',';
    put_f(s, r.temp_c, 2);
    put_f(s, r.hum_pct, 1);
    put_f(s, r.pressure_hpa, 1);
    if (r.gas_ohm) s += String(r.gas_ohm);
    s += ',';
    if (r.iaq >= 0) s += String(r.iaq);
    s += ',' + String(r.iaq_acc) + ',';
    put_f(s, r.co2_eq, 0);
    put_f(s, r.voc_eq, 2);
    s += String(r.batt_mv) + ',';
    if (r.batt_pct >= 0) s += String(r.batt_pct);
    s += ',' + String(r.power) + ',';
    if (!isnan(r.lux)) s += String(r.lux, 0);
    s += '\n';
    return s;
}

static bool from_line(char *line, log_rec_t &r)
{
    char *f[15];
    int n = 0;
    for (char *p = line; n < 15;) {
        f[n++] = p;
        char *c = strchr(p, ',');
        if (!c) break;
        *c = 0;
        p = c + 1;
    }
    if (n < 14 || !*f[0] || !*f[2]) return false; // torn / foreign line
    auto fl = [](const char *s) { return *s ? strtof(s, nullptr) : NAN; };
    r.ts = strtoul(f[0], nullptr, 10);
    r.boot = strtoul(f[1], nullptr, 16);
    r.up_s = strtoul(f[2], nullptr, 10);
    r.temp_c = fl(f[3]);
    r.hum_pct = fl(f[4]);
    r.pressure_hpa = fl(f[5]);
    r.gas_ohm = strtoul(f[6], nullptr, 10);
    r.iaq = *f[7] ? atoi(f[7]) : -1;
    r.iaq_acc = atoi(f[8]);
    r.co2_eq = fl(f[9]);
    r.voc_eq = fl(f[10]);
    r.batt_mv = atoi(f[11]);
    r.batt_pct = *f[12] ? atoi(f[12]) : -1;
    r.power = atoi(f[13]);
    r.lux = n == 15 ? fl(f[14]) : NAN;
    return true;
}

// ---- SD queue -----------------------------------------------------------------
static void q_trim()
{
    while (q_count > LOG_MAX_FILES) {
        SD_MMC.remove(q_path(q_head));
        Serial.printf("[log] queue full, dropped batch %lu\n", (unsigned long)q_head);
        q_head++;
        q_count--;
    }
}

// cur.csv -> next batch file
static void rotate()
{
    File f = SD_MMC.open(CUR_PATH, FILE_READ);
    size_t size = f ? f.size() : 0;
    if (f) f.close();
    if (!size) { cur_lines = 0; return; }
    if (!q_count) q_head = q_tail;
    String to = q_path(q_tail);
    if (!SD_MMC.rename(CUR_PATH, to)) { Serial.println("[log] rotate failed"); return; }
    q_tail++;
    q_count++;
    cur_lines = 0;
    q_trim();
}

static void q_scan()
{
    File dir = SD_MMC.open(Q_DIR);
    uint32_t lo = UINT32_MAX, hi = 0;
    q_count = 0;
    for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
        const char *name = strrchr(f.name(), '/');
        name = name ? name + 1 : f.name();
        char *end;
        uint32_t seq = strtoul(name, &end, 10);
        f.close();
        if (end == name || strcmp(end, ".csv")) continue;
        lo = min(lo, seq);
        hi = max(hi, seq);
        q_count++;
    }
    dir.close();
    q_head = q_count ? lo : 0;
    q_tail = q_count ? hi + 1 : 0;
}

// ---- public -------------------------------------------------------------------
static void boots_load()
{
    File f = SD_MMC.open(BOOTS_PATH, FILE_READ);
    if (!f) return;
    char line[40];
    while (f.available()) {
        size_t len = f.readBytesUntil('\n', line, sizeof line - 1);
        line[len] = 0;
        char *c = strchr(line, ',');
        if (c) boots_add(strtoul(line, nullptr, 16), strtoul(c + 1, nullptr, 10));
    }
    size_t size = f.size();
    f.close();
    if (size > 4096) { // keep the file small: rewrite with the last BOOTS_MAX
        f = SD_MMC.open(BOOTS_PATH, FILE_WRITE);
        for (int i = 0; f && i < n_boots; i++) f.printf("%lx,%lu\n", (unsigned long)boots[i].id, (unsigned long)boots[i].epoch);
        if (f) f.close();
    }
}

void logq_begin(bool sd_ok)
{
    mux = xSemaphoreCreateMutex();
    boot_id = esp_random();
    sd = sd_ok;
    if (sd) {
        SD_MMC.mkdir("/log");
        SD_MMC.mkdir(Q_DIR);
        boots_load();
        q_scan();
        rotate(); // last boot's records go first
        Serial.printf("[log] SD queue: %d batch(es) waiting (%lu..%lu)\n", q_count,
                      (unsigned long)q_head, (unsigned long)(q_tail ? q_tail - 1 : 0));
    } else {
        ram = (log_rec_t *)heap_caps_malloc(RAM_MAX * sizeof(log_rec_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        Serial.println("[log] no SD card: readings kept in RAM only (1 h, lost on power off)");
    }
}

uint32_t logq_boot_id() { return boot_id; }

void logq_time_synced(time_t now)
{
    lock();
    if (!time_saved) {
        time_saved = true;
        uint32_t epoch = (uint32_t)now - millis() / 1000;
        boots_add(boot_id, epoch);
        if (sd) {
            File f = SD_MMC.open(BOOTS_PATH, FILE_APPEND);
            if (f) { f.printf("%lx,%lu\n", (unsigned long)boot_id, (unsigned long)epoch); f.close(); }
        }
    }
    unlock();
}

uint32_t logq_record_ts(const log_rec_t &r)
{
    if (r.ts) return r.ts;
    lock();
    uint32_t ts = 0;
    for (int i = n_boots - 1; i >= 0; i--)
        if (boots[i].id == r.boot) { ts = boots[i].epoch + r.up_s; break; }
    unlock();
    return ts;
}

void logq_append(const log_rec_t &r)
{
    lock();
    if (sd) {
        File f = SD_MMC.open(CUR_PATH, FILE_APPEND);
        if (f) {
            f.print(to_line(r));
            f.close();
            if (++cur_lines >= SEG_MAX) rotate();
        } else {
            Serial.println("[log] SD write failed");
        }
    } else if (ram) {
        if (ram_n == RAM_MAX) { ram_head = (ram_head + 1) % RAM_MAX; ram_n--; if (loaded_n) loaded_n--; }
        ram[(ram_head + ram_n++) % RAM_MAX] = r;
    }
    unlock();
}

int logq_next(log_rec_t *out, int max)
{
    lock();
    int n = 0;
    if (sd) {
        if (!q_count && cur_lines) rotate();
        while (q_count && !n) {
            File f = SD_MMC.open(q_path(q_head), FILE_READ);
            if (f) {
                char line[160];
                while (f.available() && n < max) {
                    size_t len = f.readBytesUntil('\n', line, sizeof line - 1);
                    line[len] = 0;
                    if (from_line(line, out[n])) n++;
                }
                f.close();
            }
            if (n) { loaded_seq = q_head; break; }
            // missing or nothing valid in it: skip
            SD_MMC.remove(q_path(q_head));
            q_head++;
            q_count--;
        }
    } else if (ram) {
        n = min(ram_n, max);
        for (int i = 0; i < n; i++) out[i] = ram[(ram_head + i) % RAM_MAX];
        loaded_n = n;
    }
    unlock();
    return n;
}

void logq_done()
{
    lock();
    if (sd) {
        if (loaded_seq == q_head && q_count) {
            SD_MMC.remove(q_path(q_head));
            q_head++;
            q_count--;
        }
        loaded_seq = UINT32_MAX;
    } else {
        ram_head = (ram_head + loaded_n) % RAM_MAX;
        ram_n -= loaded_n;
        loaded_n = 0;
    }
    unlock();
}

int logq_pending_files()
{
    lock();
    int n = sd ? q_count + (cur_lines ? 1 : 0) : (ram_n ? 1 : 0);
    unlock();
    return n;
}
