#!/bin/sh
# ADVERSUM: build a universal disk image (Apple Silicon and Intel) to hand to
# someone else. Not part of the normal fix cycle; see install.sh for that.
#
#   ./scripts/adversum/build-dmg.sh
#
# The image is ad-hoc signed and not notarized. On another Mac, Gatekeeper
# blocks the first start: System Settings → Privacy & Security → "Open Anyway".
set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

CI=true APPLE_SIGNING_IDENTITY="-" ./scripts/adversum/env.sh \
  npm run tauri build -- --target universal-apple-darwin

DMG_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
for image in "$DMG_DIR"/*.dmg; do
  echo "==> Disk image: ${REPO}/${image}"
  if [ -d /Volumes/AdversumDev ]; then
    cp -p "$image" /Volumes/AdversumDev/
    echo "==> Copy: /Volumes/AdversumDev/$(basename "$image")"
  fi
done
