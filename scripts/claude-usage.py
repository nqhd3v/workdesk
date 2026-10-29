#!/usr/bin/env python3
"""Read Claude plan usage limits and send them to Workdesk (POST /api/usage-state).

Calls the same endpoint Claude Code's /usage screen reads. No model call, so no
tokens are spent. Stdlib only, so it runs on a stock Raspberry Pi OS.

The endpoint is internal to Claude Code and undocumented: it can change without notice.

Auth, first match wins:
  CLAUDE_OAUTH_TOKEN  long-lived token from `claude setup-token` (no refresh needed)
  ~/.claude/.credentials.json  written by `claude` login; refreshed here when expired
                               and written back, so the CLI keeps working.

Env:
  WORKDESK_URL   e.g. https://workdesk.example.com
  WORKDESK_KEY   wdk_... key with scope usage_state
  DRY_RUN=1      print the payload instead of sending it
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"  # Claude Code's public OAuth client
CREDS_PATH = os.path.expanduser(os.environ.get("CLAUDE_CREDENTIALS", "~/.claude/.credentials.json"))


def http_json(url, method="GET", headers=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return json.load(res)
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url} -> {e.code}: {e.read().decode(errors='replace')[:500]}")


def access_token():
    token = os.environ.get("CLAUDE_OAUTH_TOKEN")
    if token:
        return token

    with open(CREDS_PATH) as f:
        creds = json.load(f)
    oauth = creds["claudeAiOauth"]

    # expiresAt is epoch ms. Refresh a minute early.
    if oauth["expiresAt"] / 1000 > time.time() + 60:
        return oauth["accessToken"]

    res = http_json(TOKEN_URL, "POST", body={
        "grant_type": "refresh_token",
        "refresh_token": oauth["refreshToken"],
        "client_id": CLIENT_ID,
    })
    oauth["accessToken"] = res["access_token"]
    # Refresh tokens rotate: persist the new one or the next refresh (ours or the CLI's) fails.
    oauth["refreshToken"] = res.get("refresh_token", oauth["refreshToken"])
    oauth["expiresAt"] = int((time.time() + res["expires_in"]) * 1000)

    tmp = CREDS_PATH + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        json.dump(creds, f)
    os.replace(tmp, CREDS_PATH)
    return oauth["accessToken"]


def unix(iso):
    return None if iso is None else int(datetime.fromisoformat(iso).timestamp())


def main():
    usage = http_json(USAGE_URL, headers={
        "Authorization": f"Bearer {access_token()}",
        "anthropic-beta": "oauth-2025-04-20",
    })

    session, week = usage.get("five_hour") or {}, usage.get("seven_day") or {}
    week_resets = unix(week.get("resets_at"))
    if week_resets is None:
        sys.exit(f"no weekly reset time in response: {json.dumps(usage)}")

    payload = {
        "name": "claude",
        "measured_at": int(time.time()),
        "session": {"used_pct": session.get("utilization") or 0, "resets_at": unix(session.get("resets_at"))},
        "week": {"used_pct": week.get("utilization") or 0, "resets_at": week_resets},
    }

    if os.environ.get("DRY_RUN"):
        print(json.dumps(payload, indent=2))
        return

    http_json(
        os.environ["WORKDESK_URL"].rstrip("/") + "/api/usage-state",
        "POST",
        headers={"x-workdesk-key": os.environ["WORKDESK_KEY"]},
        body=payload,
    )


if __name__ == "__main__":
    main()
