// logq.h — reading log + upload queue on the microSD card (RAM ring when there is no card).
//
// The sketch appends a record every LOG_EVERY_MS; the api task uploads them once a minute,
// oldest first, and drops what the backend accepted. Survives power loss and reboots.
#pragma once
#include <Arduino.h>
#include <time.h>

#define LOG_EVERY_MS 30000  // room climate changes slowly; 2880 records a day

struct log_rec_t {
    uint32_t ts;                         // Unix seconds, 0 = clock not synced yet when written
    uint32_t boot;                       // id of the boot that wrote it (fixes ts once NTP syncs)
    uint32_t up_s;                       // uptime when written
    float temp_c, hum_pct, pressure_hpa; // NAN = none
    uint32_t gas_ohm;                    // 0 = none
    int16_t iaq;                         // -1 = none
    uint8_t iaq_acc;                     // 0 warm-up .. 3 calibrated
    float co2_eq, voc_eq;                // ppm, NAN = none
    int16_t batt_mv;
    int8_t batt_pct;                     // -1 = unknown (USB)
    uint8_t power;                       // 0 unknown, 1 usb, 2 battery
    float lux;                           // NAN = none
};

void logq_begin(bool sd_ok);   // after SD_MMC.begin(); queues what the last boot left unsent
uint32_t logq_boot_id();
void logq_time_synced(time_t now);          // once NTP is up: remembers when this boot started
uint32_t logq_record_ts(const log_rec_t &r); // r.ts, or rebuilt from boot start + uptime; 0 = unknown
void logq_append(const log_rec_t &r);

// Upload side (api task). logq_next() rolls the current file into the queue when nothing older
// is waiting, then loads the oldest batch: returns how many records (0 = nothing to send).
// logq_done() removes that batch after the backend accepted it.
int logq_next(log_rec_t *out, int max);
void logq_done();
int logq_pending_files();      // batches waiting (SD) or 1/0 (RAM), for status pages
