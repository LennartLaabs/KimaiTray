#!/bin/sh
# ADVERSUM: build a universal disk image (Apple Silicon and Intel) to hand to
# someone else. Not part of the normal fix cycle; see install.sh for that.
#
#   ./scripts/adversum/build-dmg.sh
#
# The image is signed with the self-signed certificate "Adversum Dev"
# (signing.sh) and not notarized. That certificate means nothing on another
# Mac: Gatekeeper blocks the first start there (System Settings → Privacy &
# Security → "Open Anyway") until we sign with an Apple Developer ID. The key
# helper works there too: the keychain asks once and keeps "Always Allow"
# from one of our images to the next.
set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

. ./scripts/adversum/signing.sh
# Shows up in the app's log as "Adversum build <commit>".
ADVERSUM_BUILD="$(git rev-parse --short HEAD)"
export ADVERSUM_BUILD

# Only the app comes from the bundler. The key helper has to go in and the
# bundle be signed again before the image is made, so the image is built here.
CI=true ./scripts/adversum/env.sh \
  npm run tauri build -- --target universal-apple-darwin --bundles app
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/KimaiTray Adversum.app"
ADVERSUM_LLM_ARCH=universal adversum_add_keyhelper "$APP"
adversum_check_signature "$APP"
adversum_hide_build_copies

version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
DMG_DIR="src-tauri/target/universal-apple-darwin/release/bundle/dmg"
IMAGE="$DMG_DIR/KimaiTray Adversum_${version}_universal.dmg"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$DMG_DIR"
ditto "$APP" "$STAGE/KimaiTray Adversum.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -ov -fs HFS+ -format UDZO -volname "KimaiTray Adversum" \
  -srcfolder "$STAGE" "$IMAGE"

echo "==> Disk image: ${REPO}/${IMAGE}"
if [ -d /Volumes/AdversumDev ]; then
  cp -p "$IMAGE" /Volumes/AdversumDev/
  echo "==> Copy: /Volumes/AdversumDev/$(basename "$IMAGE")"
fi
