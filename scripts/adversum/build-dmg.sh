#!/bin/sh
# ADVERSUM: build a universal disk image (Apple Silicon and Intel) to hand to
# someone else. Not part of the normal fix cycle; see install.sh for that.
#
#   ./scripts/adversum/build-dmg.sh
#
# The image is signed with the self-signed certificate "Adversum Dev"
# (signing.sh) and not notarized. That certificate means nothing on another
# Mac: Gatekeeper blocks the first start there (System Settings → Privacy &
# Security → "Open Anyway") until we sign with an Apple Developer ID. The
# stable signature still helps the other Mac: its keychain keeps "Always
# Allow" from one of our images to the next.
set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

. ./scripts/adversum/signing.sh
# Shows up in the app's log as "Adversum build <commit>".
ADVERSUM_BUILD="$(git rev-parse --short HEAD)"
export ADVERSUM_BUILD

CI=true ./scripts/adversum/env.sh \
  npm run tauri build -- --target universal-apple-darwin
adversum_check_signature \
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/KimaiTray Adversum.app"

DMG_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
for image in "$DMG_DIR"/*.dmg; do
  echo "==> Disk image: ${REPO}/${image}"
  if [ -d /Volumes/AdversumDev ]; then
    cp -p "$image" /Volumes/AdversumDev/
    echo "==> Copy: /Volumes/AdversumDev/$(basename "$image")"
  fi
done
