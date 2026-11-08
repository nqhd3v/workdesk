# CLAUDE.md — Desk Env Module

Battery-powered desk gadget: ESP32-S3 + 1.91" AMOLED that shows the time, room
climate (BME680), Claude / Copilot usage, uploads readings to a web backend, and
plays a bomb-style countdown for meetings and end of workday (17:30).

Owner: Huy (fullstack dev, Next.js / NestJS). Embedded is a hobby: explain
hardware-specific decisions briefly, skip web basics.

## Current status

- [x] Home screen UI in LVGL (`ui.c`)
- [x] First flash on real board (landscape flipped 180°, MADCTL 0x30)
- [x] BME680 wired and reading at 0x77 through BSEC2 (`env.cpp`): IAQ, CO2e, VOC; state saved to NVS
- [x] Wi-Fi setup portal (QR, up to 5 saved networks, API token) + NTP
- [x] Reading log on SD (`logq.cpp`): every 30 s, FIFO queue, survives power loss; POST each minute
      to Workdesk `/api/module` — verified live (201, backlog flushed after an outage)
- [x] Wi-Fi: boot = full scan, saved networks in range by signal, none -> setup; a later drop
      shows Wi-Fi off and rescans every 30 s (no setup screen). Clock shows `--:--` until NTP
- [ ] BOOT short press: web login code page, QR signs in from a phone, screen at least 50 % — written, not yet verified on hardware
- [x] OTA over HTTP (`POST /update`) verified on hardware; on-screen progress + 5 s reboot warning
- [ ] OTA via ArduinoOTA/espota — board side works, but macOS blocks python LAN UDP (Local Network privacy)
- [x] Meeting reminder page (`UI_PAGE_MEETING`): `remind_min` before start (web setting, default 5, 0 = off),
      name (32 bold, 2 lines) + start-end + location, header "IN 4 MIN" / "IN 40 SEC" / TIME'S UP held 60 s,
      BOOT dismisses — written, not yet verified on hardware
- [ ] End-of-work bomb countdown + alerts
- [ ] Power modes (deep sleep, presence via phone BLE, IMU wake)
- [ ] VBUS sense mod (see Hardware) to tell USB from battery

Update this list when a milestone lands.

## Hardware

Board: **Waveshare ESP32-S3-AMOLED-1.91** (non-touch). ESP32-S3R8, 16 MB flash,
8 MB OPI PSRAM, 536×240 AMOLED (RM67162, driven by the SH8601 QSPI driver),
QMI8658 IMU, microSD, LiPo charger on an MX1.25 port.
Vendor examples: https://github.com/waveshareteam/ESP32-S3-AMOLED-1.91

| Function | GPIO | Notes |
|---|---|---|
| LCD CS / PCLK | 6 / 47 | QSPI, SPI2_HOST, 40 MHz |
| LCD D0 / D1 / D2 / D3 | 18 / 7 / 48 / 5 | |
| LCD RST | 17 | on header — never reuse |
| I2C SDA / SCL | 40 / 39 | shared: QMI8658 (0x6B), BME680 (0x76/0x77), FT3168 touch (0x38, touch boards only) |
| SD CLK / CMD / D0 | 9 / 42 / 8 | SD_MMC 1-bit mode (board V2 pinout) |
| Battery ADC | 1 | 1:2 divider → mV × 2 |
| BOOT button | 0 | planned: long-press 5 s = setup portal; RTC-capable wake pin |

External sensors, both optional and found while running (`env.cpp`): **BME680** (0x76/0x77) and
**BH1750** (0x23/0x5C) on IO40/IO39 + 3V3/GND.
No buzzer → brightness must come from a schedule or the backend.

From the schematic (files.waveshare.com/wiki/ESP32-S3-AMOLED-1.91/ESP32-S3-AMOLED-1.91.pdf):
IMU INT1/INT2 = GPIO45/46. Charger PL4054: its CHRG pin only drives an LED. VBUS reaches only
header H2 pin 1 — **no GPIO senses USB power**. Without a battery, GPIO1 reads the charger
output (~4.2 V → "98 %"). Fix = 100k/100k divider H2-1 → free ADC pin, set `PIN_VBUS_SENSE`.
Until then USB is detected only when a computer enumerates the USB port (`HWCDC::isPlugged`).
RST is the chip-enable line (hardware reset, firmware can't read it); BOOT (GPIO0) is the only button.

## Toolchain

- Arduino IDE 2.x, **esp32 core ≥ 3.3.0**.
- **LVGL 8.4.0** from Waveshare's `01_Arduino_Libraries/lvgl8/` (copy `lvgl/` and
  `lv_conf.h` into the Arduino `libraries` folder). Do NOT upgrade to LVGL 9 — the
  display glue, `lv_disp_drv_t` API and image format here are LVGL 8.
- `lv_conf.h` (device): `LV_COLOR_DEPTH 16`, `LV_COLOR_16_SWAP 1`, `LV_MEM_SIZE 48 KB`,
  **`LV_USE_QRCODE 1`** (setup screen QR; builds without it but shows no QR).
  **LVGL pool in PSRAM** (`LV_MEM_POOL_INCLUDE <esp_heap_caps.h>`, `LV_MEM_POOL_ALLOC(size)
  heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)`, replacing the two `#undef`s).
  Required: mbedTLS is internal-RAM only and HTTPS fails with "SSL - Memory allocation failed"
  when the 48 KB pool sits in internal RAM. Original kept as `lv_conf.h.bak-before-psram`.
- Board settings: ESP32S3 Dev Module · USB CDC On Boot Enabled · QIO 80 MHz ·
  16 MB · Partition "16M Flash (3MB APP/9.9MB FATFS)" · PSRAM OPI.
- Libraries: bsec2 1.10 (Bosch, + BME68x Sensor library), ArduinoJson 7. Later: NimBLE-Arduino. Web portal uses the core's WebServer / DNSServer.
- Upload trouble: hold BOOT, tap RST, release BOOT, upload.

Moving to PlatformIO (pioarduino platform for core 3.x) is fine if it helps;
keep the Arduino sketch building too, or ask first.

## Repo layout

Flat Arduino sketch: the folder is `firmware/`, so the sketch is `firmware.ino` (names must match).

```
firmware.ino       display init, LVGL task, sensors, SD, battery, BOOT button, pages, glue
ui.c / ui.h         all screens — pure LVGL, no Arduino/ESP calls
net.cpp / net.h     Wi-Fi: saved networks, setup portal (AP + captive page), NTP, OTA
api.cpp / api.h     backend sync task (GET data, POST readings), quarter-hour schedule
fwupdate.cpp / .h   background update: /api/module/config reports the version, signed latest.json + image from the workdesk repo go to the idle slot on the API task (one TLS session fits in RAM), BOOT on home installs
fw_pubkey.h         public key that latest.sig is checked against (private key: ~/.config/workdesk/firmware-signing.pem)
build_opt.h         -DUPDATE_SIGN, turns on the core's signature verifier
web.cpp / web.h     local web page while connected: http://workdesk.local, one-time login code (BOOT shows it, 1 min, single use)
settings.cpp / .h   user settings in NVS "cfg": brightness, NORMAL / SAVE BATTERY, night off, temp offset, meeting remind minutes
env.cpp / env.h     optional BME680 (BSEC2) and BH1750, found while running, in their own task (PSRAM stack), calibration state in NVS "bsec"
logq.cpp / logq.h   reading log + upload queue on SD: /log/cur.csv, /log/q/NNNNNNNN.csv, /log/boots.csv
(contracts: ../docs/api.md + openapi.yaml — POST /api/module, GET /api/module/config; user guide: ../docs/firmware.md)
jbm_*.c             generated fonts (do not hand-edit)
web_font.c          JetBrains Mono woff2 for the portal page (generated)
img_*.c             generated icons (do not hand-edit)
esp_lcd_sh8601.*    panel driver from Waveshare example (Apache-2.0)
```

## Commands

```bash
# Publish a release (bump FW_VERSION first): builds, signs, then asks before committing and pushing
# firmware/ in the public workdesk repo. Each module downloads it after its next sync and installs it on BOOT.
# Losing the private key means the next firmware (with a new fw_pubkey.h) has to go in over USB.
./release.sh
FQBN="esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi"
arduino-cli compile --fqbn "$FQBN" .
arduino-cli upload  --fqbn "$FQBN" -p /dev/cu.usbmodem101 .
arduino-cli monitor -p /dev/cu.usbmodem101 -c baudrate=115200
# OTA over Wi-Fi via HTTP (password = login code: press BOOT, valid 1 min, single use)
curl -u admin:<code> -F firmware=@$HOME/Library/Caches/arduino/sketches/<hash>/firmware.ino.bin \
  http://workdesk.local/update
# ArduinoOTA alternative (needs python allowed on the local network; AP password = setup screen, hold BOOT 5 s)
python3 ~/Library/Arduino15/packages/esp32/hardware/esp32/*/tools/espota.py \
  -i workdesk.local -a <AP password> -f ~/Library/Caches/arduino/sketches/*/firmware.ino.bin

# Fonts: lv_font_conv@1.5.2 + @fontsource/jetbrains-mono (see each jbm_*.c header for options)
```

Upload fails with "No serial data received": hold BOOT, tap RST, release BOOT, upload again.

There is no host simulator in this repo: UI changes are checked on the board (ask the user
what the screen shows).

## UI rules (design decisions already made)

- Screen 536×240 landscape, **true black background**. No grey panel fills
  (AMOLED: lit pixels cost power and burn in). Thin borders only.
- Font: **JetBrains Mono** only. Sizes on device: 13 (labels), 15 (date, units),
  18 medium (seconds), 32 bold (values; `jbm_b32t` = full text for meeting titles), 60 bold (clock).
  Nothing smaller than 13 px.
- Palette: ink `#F2F2F2`, dim `#8A8A8A`, faint `#3A3A3A`, rule `#262626`,
  amber `#F5A524`, cyan `#4FD1E8`, green `#3DDC84`, Claude `#D97757`, Copilot `#8B7CF6`.
- Home layout: status bar (sync dot only: grey idle, yellow uploading, green 5 s after an upload,
  red offline / upload failing · Wi-Fi bars, SD size, battery) · clock + date
  top-left · Claude and Copilot tiles side by side under the clock · env column on
  the right (TEMP, HUMIDITY, AIR/IAQ).
- AI tiles: icon + big %. The tile **border is the progress bar** (clockwise from top-left).
  Claude: border + big % = session %, "WK" % + small bar = week %; no running session (`resets_at` null / past) = grey `--`. Copilot: border + big % = month %. A tile appears once its tool was received this boot; afterwards
  stale data (tool missing from the response, `measured_at` > 1 h, or no good GET for 5 min)
  keeps the last values in **grey** instead of hiding the tile. None ever received -> big clock.
- Missing data shows `--`, never fake zeros.
- Icons are LV_IMG_CF_ALPHA_8BIT, coloured with `img_recolor`.
- Countdown screen (end of work): `00:10 → 00:00` (mm:ss, not hh:mm:ss), then "TIME'S UP" + small
  text held ~60 s. Meeting screen: name is the focus, then start time (amber) - end, location;
  time left only as small header text ("IN 4 MIN"); no clickable links.
- Burn-in: plan a few-pixel layout shift every few minutes for static elements.

## Code conventions

- `ui.c` stays pure LVGL so the simulator can build it. Hardware lives in the sketch.
- Every LVGL call from outside the LVGL task must hold the mutex (`lvgl_lock()` /
  `lvgl_unlock()`). UI setters in `ui.h` assume the lock is held.
- `lv_line` point arrays must stay alive (static/struct member), LVGL keeps the pointer.
- Children of a bordered object are offset by its border width — overlay graphics
  that must line up with a border (the progress line) are created on the parent.
- Panel flush areas must be even-aligned (rounder callback in the sketch).
- No secrets in the repo: Wi-Fi, API token, backend URL go to NVS via the setup portal.
- Prefer small, testable steps; flash-test hardware changes one at a time.

## Planned architecture (see docs/desk-env-module.drawio)

FreeRTOS tasks: SensorTask (BSEC2, battery) · UiTask (LVGL) · NetTask (Wi-Fi, NTP,
upload, event sync, OTA) · HttpServer (setup page, `GET /api/status`) ·
PresenceTask (BLE scan, iPhone IRK match) · Scheduler (17:30 + meetings) ·
PowerManager (Active on USB / Present / Eco deep sleep / Alert).

- Backend: **Workdesk ingest API** (`../docs/api.md`, `openapi.yaml`).
  `POST {url}/api/module`, header `x-workdesk-key: wdk_...` (key scope `module`, bound to the first
  `device.id`, expires ≤ 1 year), success `201 {received, stored, server_time}`, unique per
  `(device.id, ts)`. Retry only 5xx / network; 400/413/422 drop the batch; 401/403 keep it.
  URL + key live in NVS ("net"/"api_url", "api_token"): setup page BACKEND section, or
  `curl -u admin:<code> -d '{"url":"https://...","key":"wdk_..."}' http://workdesk.local/api/backend`.
  Local copies for provisioning in `.env` (git-ignored, never commit). `http://` URLs work for local tests.
  POST: every minute from the SD queue (oldest batch first, 2 retries within the minute).
  GET `{url}/api/module/config` every minute after the POST (rate limit 10/min/key, 429 ->
  `Retry-After`): `usage_states[]` (claude: session + week %, copilot: month %), `events[]` (meetings page),
  `firmware.version`, `server_time`. Workday end stays the local default (17:30 Mon–Fri). Times are Unix seconds.
  `/api/status` on the device shows the parsed usage + `reset` (last reset reason).
  Records written before NTP carry boot id + uptime; `/log/boots.csv` maps boot id -> start time.
- Local API only when awake on Wi-Fi: `GET /api/status` with `X-Device-Token`.
- Offline: readings stay queued on SD (1 h per batch file at 30 s, 30 days max, oldest dropped first).
- Timezone `ICT-7` (Asia/Ho_Chi_Minh). Work end 17:30 Mon–Fri (configurable).
- Claude / Copilot numbers come from the backend (source TBD — no confirmed public
  API for personal plan usage; likely a laptop script → backend → device).

## Gotchas

- BME680 reads 1–3 °C high near the ESP32/battery: mount on a short cable, add a
  temperature offset setting.
- IAQ: BSEC reports accuracy 0 ("WARM-UP", IAQ stuck at 50) for ~5 min after boot, then calibrates
  over hours (config `bme680_iaq_33v_3s_4d`, LP 3 s). State is saved at accuracy 3, then every 4 h.
  SAVE BATTERY mode does not slow BSEC yet (ULP 300 s needs the 300s config + a resubscribe).
- Internal RAM is tight (~15 KB free with Wi-Fi up). Put new big buffers / task stacks in PSRAM;
  a task with a PSRAM stack must not write flash (NVS) itself.
- Battery % from voltage is rough; on USB without a battery it reads ~100 %.
- Deep sleep kills Wi-Fi and the HTTP server: live local API only in Active/Present.
- MX1.25 LiPo plugs often have reversed polarity — check before plugging in.
