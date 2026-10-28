# Workdesk Ingest API

Push data from external senders into Workdesk. There are three write-only endpoints:

| Endpoint | Key scope | Sender | Stores |
|---|---|---|---|
| `POST /api/module` | `module` | IoT module | Environment readings (temperature, humidity, pressure, gas, battery) |
| `POST /api/events` | `events` | Calendar source (e.g. Google Apps Script) | Current list of upcoming events |
| `POST /api/usage-state` | `usage_state` | Usage client | Plan usage limits over time |

The machine-readable contract is [`openapi.yaml`](./openapi.yaml). It is the source of truth if this guide and the spec ever disagree.

## Before you start

1. **Get an API key.** The Workdesk owner creates one at **Settings → API keys**, picking the endpoint it is for.
   The key is shown **once**. Store it as a secret on the sender (firmware config, Apps Script properties, etc.).
2. **Keys expire.** Every key has an expiry date, at most 1 year after creation. Rotate before it expires
   (see [Key lifecycle](#key-lifecycle)).
3. **One key per sender.** A key works only on the endpoint it was created for.
   Module keys also bind to the first `device.id` they send (see [Module](#post-apimodule)).
4. **Base URL.** Your Workdesk deployment's origin, e.g. `https://workdesk.example.com`. Locally: `http://localhost:3000`.
5. **HTTPS.** Always use HTTPS outside local development. The key is a bearer secret.

## Request basics

Every request:

```http
POST /api/<endpoint>
Content-Type: application/json
x-workdesk-key: wdk_<43 characters>
```

- Body: JSON, max **256 KB**. Field names are `snake_case`.
- **All timestamps are Unix seconds** (integer, UTC). Unless stated otherwise they must be after 2024-01-01
  and at most 24 hours in the future. No timezones, no strings: the sender converts once, the server never guesses.
- Unknown fields are ignored.

## Responses

Success is always `201`. Every success body includes `server_time` (Unix seconds), so senders without NTP can
detect clock drift: if `|server_time - device_time|` is large, resync before sending more readings.

Errors share one shape:

```json
{
  "error": {
    "code": "invalid_payload",
    "message": "Payload failed validation.",
    "issues": [{ "path": "readings.0.ts", "message": "Timestamp (unix seconds) out of range" }]
  }
}
```

| Status | `code` | Meaning | What to do |
|---|---|---|---|
| 201 | n/a | Accepted | — |
| 400 | `invalid_json` | Body is not valid JSON | Fix serialization. Do not retry as-is. |
| 401 | `unauthorized` | Header missing/malformed, unknown key, or revoked key | Check the key. Ask the owner for a new one if revoked. |
| 401 | `key_expired` | Key is past its expiry date | Ask the owner for a new key. |
| 403 | `forbidden` | Key belongs to a different endpoint | Use the key created for this endpoint. |
| 403 | `device_mismatch` | Module key already bound to another device | Use a separate key per device. |
| 413 | `payload_too_large` | Body > 256 KB | Send fewer readings per request. |
| 422 | `invalid_payload` | Valid JSON, wrong shape/values. `issues[]` lists each field | Fix the fields listed. Do not retry as-is. |
| 500 | `internal_error` | Server problem | Retry with backoff. |

**Retry rule:** retry only on `500` or network errors, with exponential backoff. Never retry `4xx` unchanged.

---

## POST /api/module

Environment report from an IoT module. Send one or many readings per request, e.g. buffer readings and flush every few minutes.

**Preconditions**
- Key scope `module`.
- The first successful request binds the key to its `device.id`. Afterwards, any other `device.id` gets `403 device_mismatch`.
- Device clock must be synced (NTP), because `ts` is validated against server time.

**Idempotency:** readings are unique per `(device.id, ts)`. Re-sending a report after a timeout is safe: duplicates are skipped and `stored` counts only new readings.

### Body

| Field | Type | Required | Rules |
|---|---|---|---|
| `v` | integer | yes | Must be `1` (payload format version). |
| `device.id` | string | yes | 1–64 chars, stable per device. |
| `device.fw` | string | no | ≤ 32 chars. |
| `device.uptime_s` | integer | no | ≥ 0. |
| `power.source` | string | no | ≤ 16 chars, e.g. `battery`, `usb`. |
| `power.batt_mv` | integer \| null | no | ≥ 0. |
| `power.batt_pct` | number \| null | no | 0–100. |
| `readings` | array | yes | 1–1000 items. |
| `readings[].ts` | integer | yes | Unix **seconds**. |
| `readings[].temp_c` | number \| null | no | −60–100. |
| `readings[].hum_pct` | number \| null | no | 0–100. |
| `readings[].pressure_hpa` | number \| null | no | 300–1200. |
| `readings[].gas_ohm` | integer \| null | no | ≥ 0. |
| `readings[].iaq` | number \| null | no | 0–500. |
| `readings[].batt_mv` | integer \| null | no | ≥ 0. |
| `wifi.ssid` | string | no | ≤ 64 chars. |
| `wifi.rssi` | integer | no | −127–0 dBm. |
| `wifi.ip` | string | no | ≤ 45 chars. |

Sensor values may be omitted or `null`, e.g. while a sensor warms up.

### Example

```bash
curl -X POST "$WORKDESK_URL/api/module" \
  -H "Content-Type: application/json" \
  -H "x-workdesk-key: $WORKDESK_KEY" \
  -d '{
    "v": 1,
    "device": { "id": "workdesk-8734", "fw": "0.4.0", "uptime_s": 5423 },
    "power":  { "source": "battery", "batt_mv": 3912, "batt_pct": 71 },
    "readings": [
      { "ts": 1793242800, "temp_c": 28.16, "hum_pct": 48.7, "pressure_hpa": 1005.1, "gas_ohm": 45881, "iaq": null, "batt_mv": 3915 },
      { "ts": 1793242920, "temp_c": null, "hum_pct": null, "pressure_hpa": null, "gas_ohm": null, "iaq": null, "batt_mv": 3912 }
    ],
    "wifi": { "ssid": "ONE_CLT", "rssi": -76, "ip": "10.84.240.53" }
  }'
```

```json
{ "received": 2, "stored": 2, "server_time": 1793242925 }
```

---

## POST /api/events

Snapshot of upcoming events, e.g. pushed by a Google Apps Script time trigger.

**Preconditions**
- Key scope `events`.

**Semantics:** each request **replaces** the current list. Send all upcoming events every time; `"events": []` clears the list. Events are stored sorted by `start`.

### Body

| Field | Type | Required | Rules |
|---|---|---|---|
| `sent_at` | integer | yes | When the snapshot was taken, Unix seconds. |
| `events` | array | yes | 0–100 items. |
| `events[].id` | string | no | Source event id, 1–256 chars. Recommended. |
| `events[].title` | string | yes | 1–200 chars. |
| `events[].start` | integer | yes | Unix seconds, up to 366 days ahead. |
| `events[].end` | integer | yes | Unix seconds, `end >= start`, at most 7 days after `start`. |

### Example

```bash
curl -X POST "$WORKDESK_URL/api/events" \
  -H "Content-Type: application/json" \
  -H "x-workdesk-key: $WORKDESK_KEY" \
  -d '{
    "sent_at": 1793260800,
    "events": [
      { "id": "abc123@google.com", "title": "Daily Meeting", "start": 1793262600, "end": 1793263500 },
      { "title": "Retro", "start": 1793277600, "end": 1793281200 }
    ]
  }'
```

```json
{ "events": 2, "server_time": 1793260801 }
```

Google Apps Script sender (run from a time-driven trigger, e.g. every 10 minutes):

```js
function pushEvents() {
  const key = PropertiesService.getScriptProperties().getProperty("WORKDESK_KEY");
  const secs = (d) => Math.floor(d.getTime() / 1000);
  const now = new Date();
  const until = new Date(now.getTime() + 24 * 3600 * 1000);
  const events = CalendarApp.getDefaultCalendar()
    .getEvents(now, until)
    .map((e) => ({ id: e.getId(), title: e.getTitle(), start: secs(e.getStartTime()), end: secs(e.getEndTime()) }));

  const res = UrlFetchApp.fetch("https://workdesk.example.com/api/events", {
    method: "post",
    contentType: "application/json",
    headers: { "x-workdesk-key": key },
    payload: JSON.stringify({ sent_at: secs(now), events }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 201) console.error(res.getResponseCode(), res.getContentText());
}
```

---

## POST /api/usage-state

Current plan usage limits for one tool (`claude` or `copilot`). Each request is stored as a point in time, so Workdesk can chart usage over time.
Usage is grouped per limit window, so new windows can be added later without breaking senders.

**Preconditions**
- Key scope `usage_state`.

### Body

| Field | Type | Required | Rules |
|---|---|---|---|
| `name` | string | yes | Tool the limits belong to: `claude` or `copilot`. |
| `measured_at` | integer | yes | When the values were read, Unix seconds. |
| `session.used_pct` | number | yes | 0–100. |
| `session.resets_at` | integer \| null | yes | When the session limit resets, Unix seconds (≤ 30 days ahead). `null` while no session is active (a session starts with the first message). |
| `week.used_pct` | number | yes | 0–100. |
| `week.resets_at` | integer | yes | When the weekly limit resets, Unix seconds (≤ 30 days ahead). |

Send absolute reset times, not "hours left": a relative value goes stale as soon as the request is delayed.

### Example

```bash
curl -X POST "$WORKDESK_URL/api/usage-state" \
  -H "Content-Type: application/json" \
  -H "x-workdesk-key: $WORKDESK_KEY" \
  -d '{
    "name": "claude",
    "measured_at": 1793260800,
    "session": { "used_pct": 42.5, "resets_at": 1793273400 },
    "week":    { "used_pct": 18,   "resets_at": 1793606400 }
  }'
```

```json
{ "server_time": 1793260801 }
```

No active session:

```json
{
  "name": "copilot",
  "measured_at": 1793260800,
  "session": { "used_pct": 0, "resets_at": null },
  "week":    { "used_pct": 18, "resets_at": 1793606400 }
}
```

---

## Key lifecycle

- **Create:** Settings → API keys → New key → pick the endpoint and expiry (30 days, 90 days, 6 months, 1 year, or a custom date up to 1 year). Copy the key immediately; only a prefix (`wdk_xxxxxxxx…`) is kept for display.
- **Expire:** after its expiry date a key gets `401 key_expired`. Expiry cannot be extended; create a new key.
- **Rotate:** before expiry, create a new key, update the sender, then revoke the old key. The keys page flags keys expiring within 7 days.
- **Revoke:** Settings → API keys → Revoke. Takes effect immediately (`401` on next request) and cannot be undone.
- **Lost key:** it cannot be recovered. Revoke it and create a new one.
