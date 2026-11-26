#!/bin/sh
# ADVERSUM: which code-signing identity release builds use. Sourced by
# install.sh and build-dmg.sh; sets APPLE_SIGNING_IDENTITY for the Tauri
# bundler.
#
# Builds are signed with the self-signed certificate "Adversum Dev" from the
# login keychain (create it once with setup-signing.sh). Every build then has
# the same designated requirement (bundle identifier + this certificate), so
# macOS keeps privacy permissions such as the microphone across builds. An
# ad-hoc signature ("-") changes with every build. The keychain needs more
# than that: see adversum_add_keyhelper below.
#
# Without the certificate (another Mac, CI) the build falls back to ad hoc.

ADVERSUM_SIGN_IDENTITY="${ADVERSUM_SIGN_IDENTITY:-Adversum Dev}"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"${ADVERSUM_SIGN_IDENTITY}\""; then
  APPLE_SIGNING_IDENTITY="$ADVERSUM_SIGN_IDENTITY"
else
  echo "WARNING: no valid signing identity \"${ADVERSUM_SIGN_IDENTITY}\" in the keychain." >&2
  echo "         Signing ad hoc; macOS will ask for keychain access after every build." >&2
  echo "         Run ./scripts/adversum/setup-signing.sh once to fix that." >&2
  APPLE_SIGNING_IDENTITY="-"
fi
export APPLE_SIGNING_IDENTITY

# Puts the key helper into an app bundle and signs the bundle again.
#
# The certificate alone does not keep the keychain quiet: without an Apple
# team ID, macOS identifies a program by the hash of its code, so every new
# build of the app would be asked for the API token again. The helper
# (keyhelper/keyhelper.c) is built once and then stays byte for byte the
# same; the app reads the token through it. Skipped for ad-hoc builds, which
# the helper would not accept as its caller anyway.
adversum_add_keyhelper() {
  [ "$APPLE_SIGNING_IDENTITY" != "-" ] || return 0
  helper="$(./scripts/adversum/keyhelper/build.sh)"
  cp "$helper" "$1/Contents/MacOS/kimaitray-keyhelper"
  # The helper for Apple's on-device language model, where it can be built.
  extract="$(./scripts/adversum/extract/build.sh)"
  if [ -n "$extract" ]; then
    cp "$extract" "$1/Contents/MacOS/kimaitray-extract"
    codesign --force --options runtime -s "$APPLE_SIGNING_IDENTITY" \
      "$1/Contents/MacOS/kimaitray-extract"
    echo "==> On-device language model helper added"
  fi
  codesign --force --options runtime --entitlements src-tauri/Entitlements.plist \
    -s "$APPLE_SIGNING_IDENTITY" "$1"
  echo "==> Key helper: $(codesign -dvvv "$1/Contents/MacOS/kimaitray-keyhelper" 2>&1 | sed -n 's/^CDHash=//p')"
}

# Keeps the copies in the build folder out of Spotlight and Launch Services.
#
# Every build leaves an app bundle with the app's name and identifier under
# src-tauri/target. Spotlight and "Open With" offer those like the installed
# app, and an older one of them was started that way and ran old code on the
# real data (2026-11-26). Nothing is deleted: the folder is marked as not to
# be indexed, and the bundles are taken off the list of known apps.
adversum_hide_build_copies() {
  [ -d src-tauri/target ] || return 0
  touch src-tauri/target/.metadata_never_index
  lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  [ -x "$lsregister" ] || return 0
  find src-tauri/target -maxdepth 6 -name "*.app" -type d -path "*/bundle/macos/*" 2>/dev/null |
    while IFS= read -r copy; do
      "$lsregister" -u "$copy" >/dev/null 2>&1 || true
    done
}

# Prints how an app bundle is signed and fails if the signature is broken.
adversum_check_signature() {
  codesign --verify --strict "$1" || {
    echo "Signature of $1 does not verify." >&2
    return 1
  }
  authority="$(codesign -dvv "$1" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
  requirement="$(codesign -d -r- "$1" 2>/dev/null | sed -n 's/^designated => //p')"
  echo "==> Signed by: ${authority:-ad hoc}"
  echo "==> Designated requirement: ${requirement}"
}
