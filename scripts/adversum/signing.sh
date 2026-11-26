#!/bin/sh
# ADVERSUM: which code-signing identity release builds use. Sourced by
# install.sh and build-dmg.sh; sets APPLE_SIGNING_IDENTITY for the Tauri
# bundler.
#
# Builds are signed with the self-signed certificate "Adversum Dev" from the
# login keychain (create it once with setup-signing.sh). Every build then has
# the same designated requirement (bundle identifier + this certificate), so
# macOS keeps "Always Allow" for the keychain entry with the API token and the
# microphone permission across builds. An ad-hoc signature ("-") changes with
# every build, and macOS asks again each time.
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
