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

if [ "${1:-}" != "--no-build" ]; then
  echo "==> Building ${APP_NAME} (${TARGET})"
  # CI=true keeps the bundler from scripting Finder; "-" signs ad hoc.
  CI=true APPLE_SIGNING_IDENTITY="-" ./scripts/adversum/env.sh \
    npm run tauri build -- --target "$TARGET" --bundles app
fi
[ -d "$BUILT" ] || { echo "No build found at $BUILT" >&2; exit 1; }

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
if pgrep -f "/Applications/${PATTERN}" >/dev/null 2>&1; then
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INSTALLED/Contents/Info.plist")"
  echo "==> Installed and running: ${APP_NAME} ${version} ($(git rev-parse --short HEAD))"
else
  echo "The app was installed but did not start." >&2
  exit 1
fi
