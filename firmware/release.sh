#!/usr/bin/env bash
# Builds and signs the firmware, then publishes it to the public workdesk repo. Workdesk redeploys with
# the new latest.json, so modules learn the version on their next sync, download it and wait for BOOT.
# Bump FW_VERSION in firmware.ino first: a module only takes a version newer than its own.
set -euo pipefail
cd "$(dirname "$0")"

FQBN="esp32:esp32:esp32s3:CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi"
BIN=build/ota/firmware.ino.bin
KEY=${FW_SIGNING_KEY:-$HOME/.config/workdesk/firmware-signing.pem}
VERSION=$(sed -n 's/^#define FW_VERSION "\(.*\)"/\1/p' firmware.ino)

[ -r "$KEY" ] || { echo "Signing key not found: $KEY" >&2; exit 1; }

arduino-cli compile --fqbn "$FQBN" --output-dir build/ota .

# The repo is public. Keys belong in NVS, never in the image.
if strings "$BIN" | grep -qE 'wdk_[A-Za-z0-9_-]{20,}'; then
  echo "API key found in the firmware image, not publishing." >&2
  exit 1
fi

OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
printf '{"version":"%s","sha256":"%s"}\n' "$VERSION" "$(shasum -a 256 "$BIN" | cut -d' ' -f1)" > "$OUT/latest.json"
openssl dgst -sha256 -sign "$KEY" -out "$OUT/sig.der" "$OUT/latest.json"
xxd -p -c 256 "$OUT/sig.der" > "$OUT/latest.sig"

# Refuse a key the firmware wouldn't accept.
sed -n 's/^ *"\(.*\)\\n"$/\1/p' fw_pubkey.h > "$OUT/pub.pem"
openssl dgst -sha256 -verify "$OUT/pub.pem" -signature "$OUT/sig.der" "$OUT/latest.json" > /dev/null

# Modules in the field download these exact paths, see RELEASE_URL in fwupdate.cpp.
cp "$BIN" desk-bomb.bin
cp "$OUT/latest.json" "$OUT/latest.sig" .

read -r -p "Commit and push $VERSION to the public repo? [y/N] " answer
if [ "$answer" != y ]; then
  echo "Not published. Signed files are in firmware/."
  exit 0
fi

git add desk-bomb.bin latest.json latest.sig
git commit -m "release firmware $VERSION" -- desk-bomb.bin latest.json latest.sig
git push origin main
