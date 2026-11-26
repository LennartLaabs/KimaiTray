#!/bin/sh
# ADVERSUM: build the release app and install it on this Mac.
#
#   ./scripts/adversum/install.sh             build, quit, replace, start
#   ./scripts/adversum/install.sh --no-build  install the last release build
#
# Steps: release build for this Mac's architecture (no disk image), quit the
# running "KimaiTray Adversum", replace /Applications/KimaiTray Adversum.app,
# start it again. Settings, favorites and the API token are not touched: they
# live in ~/Library/Application Support/io.adversum.kimaitray and in the
# keychain, not in the app bundle.
#
# The build is signed with the certificate "Adversum Dev" (signing.sh), so
# macOS recognizes every build as the same app and does not ask for the
# keychain again. Only the copy in /Applications is ever started: a second
# copy from the build folder would be a different app to the keychain.
#
# For a disk image to hand to someone else, use build-dmg.sh instead.
set -eu

APP_NAME="KimaiTray Adversum"
INSTALLED="/Applications/${APP_NAME}.app"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

case "$(uname -m)" in
  arm64) TARGET="aarch64-apple-darwin" ;;
  x86_64) TARGET="x86_64-apple-darwin" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
BUILT="src-tauri/target/${TARGET}/release/bundle/macos/${APP_NAME}.app"

. ./scripts/adversum/signing.sh

if [ "${1:-}" != "--no-build" ]; then
  echo "==> Building ${APP_NAME} (${TARGET}), signing with \"${APPLE_SIGNING_IDENTITY}\""
  # CI=true keeps the bundler from scripting Finder.
  CI=true ./scripts/adversum/env.sh \
    npm run tauri build -- --target "$TARGET" --bundles app
fi
[ -d "$BUILT" ] || { echo "No build found at $BUILT" >&2; exit 1; }
adversum_check_signature "$BUILT"

echo "==> Quitting the running app"
# Matches the installed app and a copy started from a build folder alike.
PATTERN="${APP_NAME}.app/Contents/MacOS/"
if pgrep -f "$PATTERN" >/dev/null 2>&1; then
  pkill -f "$PATTERN" || true
  waited=0
  while pgrep -f "$PATTERN" >/dev/null 2>&1; do
    waited=$((waited + 1))
    if [ "$waited" -gt 20 ]; then
      pkill -9 -f "$PATTERN" || true
      break
    fi
    sleep 0.5
  done
fi

echo "==> Replacing ${INSTALLED}"
STAGED="/Applications/.${APP_NAME}.installing.app"
rm -rf "$STAGED"
ditto "$BUILT" "$STAGED"
rm -rf "$INSTALLED"
mv "$STAGED" "$INSTALLED"

echo "==> Starting ${APP_NAME}"
open "$INSTALLED"
sleep 2
others="$(pgrep -fl "$PATTERN" | grep -v " /Applications/${PATTERN}" || true)"
if [ -n "$others" ]; then
  echo "WARNING: another copy of the app is running outside /Applications:" >&2
  echo "$others" >&2
fi
if pgrep -f "/Applications/${PATTERN}" >/dev/null 2>&1; then
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALLED/Contents/Info.plist")"
  echo "==> Installed and running: ${APP_NAME} ${version} ($(git rev-parse --short HEAD))"
else
  echo "The app was installed but did not start." >&2
  exit 1
fi
