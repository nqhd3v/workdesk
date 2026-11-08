# Workdesk firmware

Firmware for the Workdesk desk module: an ESP32-S3 board with a small AMOLED screen. It shows the time, room readings, and Claude and Copilot usage, and sends readings to Workdesk.

Source is in [`firmware/`](https://github.com/nqhd3v/workdesk/tree/main/firmware). For the HTTP contract it uses, see the [API docs](/docs).

## Hardware

| Part | Notes |
|---|---|
| Board | Waveshare ESP32-S3-AMOLED-1.91, non-touch. 536×240 AMOLED, 16 MB flash, 8 MB PSRAM. |
| microSD | Optional. Keeps unsent readings through power loss. |
| LiPo battery | Optional, MX1.25 port. Check the plug's polarity first: these plugs are often reversed. |
| BME680 | Optional. Temperature, humidity, pressure, air quality. |
| BH1750 | Optional. Light level. |

## Wiring

Both sensors are optional and share the same four pins. Unplug USB before wiring, and keep wires under 10 cm.

| Sensor pin | Board pin |
|---|---|
| VCC / VIN | **3V3**, never 5V |
| GND | **GND** |
| SDA | **IO40** |
| SCL | **IO39** |

On the BME680, leave CS and SDO open. The firmware finds either sensor address on its own: `0x76` or `0x77` for the BME680, `0x23` or `0x5C` for the BH1750.

Keep the BME680 away from the ESP32 and the battery, because their heat makes it read 1–3 °C high. You can correct the rest with the temperature offset setting.

The board looks for sensors every 5 seconds, and shows what it finds:

| Plugged in | Screen shows |
|---|---|
| BME680 | Temperature, humidity, air quality |
| BH1750 | Light |
| Both | All of the above |
| None | Empty column |

The dashboard follows the same rule: a metric appears once it has data.

> Air quality reads `WARM-UP` for about 5 minutes after boot, then calibrates over hours. Calibration is saved and restored after a reboot.

## Build and flash

Arduino IDE 2 or `arduino-cli`, with:

- **esp32 core** 3.3.0 or newer
- **LVGL 8.4.0** from Waveshare's [demo package](https://github.com/waveshareteam/ESP32-S3-AMOLED-1.91), in `01_Arduino_Libraries/lvgl8`. Copy `lvgl/` and `lv_conf.h` into your Arduino `libraries` folder. LVGL 9 doesn't work.
- **bsec2** 1.10 from Bosch, with the **BME68x Sensor library**
- **ArduinoJson** 7

Set these in `lv_conf.h`:

| Setting | Value |
|---|---|
| `LV_COLOR_DEPTH` | `16` |
| `LV_COLOR_16_SWAP` | `1` |
| `LV_MEM_SIZE` | 48 KB |
| `LV_USE_QRCODE` | `1` |
| `LV_MEM_POOL_INCLUDE` | `<esp_heap_caps.h>` |
| `LV_MEM_POOL_ALLOC(size)` | `heap_caps_malloc(size, MALLOC_CAP_SPIRAM \| MALLOC_CAP_8BIT)` |

The LVGL memory pool has to be in PSRAM. In internal RAM, HTTPS fails with `SSL - Memory allocation failed`.

Open `firmware/firmware.ino`, or build from the `firmware/` folder:

```bash
FQBN="esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi"
arduino-cli compile --fqbn "$FQBN" .
arduino-cli upload --fqbn "$FQBN" -p /dev/cu.usbmodem101 .
```

In Arduino IDE, use: ESP32S3 Dev Module, USB CDC On Boot Enabled, QIO 80 MHz, 16 MB flash, partition "16M Flash (3MB APP/9.9MB FATFS)", OPI PSRAM.

If upload fails with `No serial data received`: hold **BOOT**, tap **RST**, release BOOT, then upload again.

## First setup

1. In Workdesk, open **Settings → API keys** and create a key with the **Module** scope. It's shown once.
2. Power on the board. With no saved network it opens the setup screen.
3. Scan the QR code with your phone, or join the Wi-Fi network shown on screen.
4. If no page opens, go to `http://192.168.4.1`.
5. Choose your Wi-Fi network, and enter your Workdesk URL and API key.

The board saves up to 5 networks and joins the strongest one in range. To change them later, hold **BOOT** for 5 seconds.

Secrets stay in the board's storage, never in the firmware image.

## Using the board

### BOOT button

| Action | Result |
|---|---|
| Press on home | Shows the web login code |
| Press on home, update waiting | Installs the update |
| Press on login code screen | Back to home |
| Press on meeting reminder | Dismisses it |
| Press during night screen-off | Wakes the screen for 30 s |
| Press on connecting screen | Skips it |
| Press on setup screen | Cancels, if a network is saved |
| Hold 5 s | Opens Wi-Fi setup |

### Home screen

- **Status bar:** sync dot, Wi-Fi, SD card size and battery. The dot is yellow while uploading, green after an upload, red when offline or failing, and gray when idle.
- **Claude tile:** big number and border show session usage, or a gray `--` when no session is running. `WK` shows weekly usage.
- **Copilot tile:** big number and border show monthly usage.
- **Tiles:** a tile appears once data arrives, and turns gray when data is old. With no tiles, the clock gets bigger.

Missing values show `--`.

### Meeting reminder

Before a meeting from your calendar starts, the board switches to a reminder with the title, time range and an `mm:ss` countdown. At the start it shows `TIME'S UP` for 1 minute, then goes back home. The reminder lights the screen during night screen-off. Set how early it appears on the web page.

### Web page

Open `http://workdesk.local` on the same network, or use the board's IP address if that name doesn't resolve.

1. Press **BOOT**. The screen shows a code and QR for 1 minute, at 50% brightness or more.
2. Scan the QR, or type the code.

Each code works once, and 5 wrong tries cancel it. Sign-in lasts 1 hour, and ends if the board reboots.

The page shows live readings, firmware status, and these settings:

| Setting | Notes |
|---|---|
| Brightness | 5–100% |
| Mode | Normal, or Save Battery, which limits brightness to 30% |
| Screen off at night | Start and end time |
| Remind before | 0–60 min before a meeting, 0 turns reminders off. Default 5 |
| Temperature offset | −10 to 10 °C |

## Sync and offline

Once a minute the board sends readings and fetches usage, events and the latest firmware version.

It records a reading every 30 seconds. Without Wi-Fi, readings wait in a queue and upload oldest first once it's back:

| Storage | Keeps |
|---|---|
| microSD | Up to 30 days, survives power loss |
| No card | About 2 hours in memory, lost on power off |

## Updates

1. Workdesk reports a newer version during sync.
2. The board downloads it in the background, and checks its signature and SHA-256.
3. Home shows `UPDATE x.y.z: PRESS BOOT`.
4. Press **BOOT** on home. The board warns for 5 seconds, then reboots into the new version.

Nothing changes until you press BOOT, even if power is lost. If the board reboots first, it downloads the update again. A failed download retries after 10 minutes.

The board only takes a version newer than its own, signed by the release key. That stops a changed repo from installing unsigned firmware, or an old release from being replayed.

> BOOT and RESET can't be used together for this. Holding BOOT during reset starts the chip's serial flashing mode, before any firmware runs.

### Publishing a release

1. Bump `FW_VERSION` in `firmware.ino`.
2. Run `./release.sh` from `firmware/`.
3. Confirm when it asks. It commits only the three release files and pushes them.

The script builds and signs the image, refuses to publish if it finds an API key inside, and checks the signature against `fw_pubkey.h`. Workdesk then redeploys and reports the new version.

The private key isn't in the repo, so keep a backup. Without it, the next firmware needs a new key and has to go in over USB. The default location is `~/.config/workdesk/firmware-signing.pem`, or set `FW_SIGNING_KEY`.

Modules download `firmware/latest.json`, `latest.sig` and `desk-bomb.bin` by those exact paths, so don't rename them.

### Manual upload

Press **BOOT**, and use the code as the password:

```bash
curl -u admin:<code> -F firmware=@firmware.ino.bin http://workdesk.local/update
```

## Troubleshooting

| Problem | Check |
|---|---|
| Sync dot is red | Wi-Fi, then the serial log at 115200. `401` or `403` means the API key is wrong, revoked, or expired. |
| Temperature reads high | Move the BME680 away from the board, or set the temperature offset. |
| `workdesk.local` doesn't open | Phone and board must share a network. Some Android browsers don't resolve `.local`, so use the IP address. |
| Code expired | Press **BOOT** for a new one. |
| Battery shows about 100% on USB | Expected. Without a battery, the reading is the charger's output. |
