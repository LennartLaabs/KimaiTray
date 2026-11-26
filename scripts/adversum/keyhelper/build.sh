#!/bin/sh
# ADVERSUM: builds and signs kimaitray-keyhelper once and prints its path.
#
#   ./scripts/adversum/keyhelper/build.sh
#
# The result is cached, and reused for every app build as long as the source,
# the signing certificate and the build flags stay the same. That is the
# point: the keychain permission is tied to this exact binary. A rebuilt
# helper is a new program to macOS, and it asks for the keychain once more.
#
# Needs the signing certificate (signing.sh, setup-signing.sh).
set -eu

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
SOURCE="$REPO/scripts/adversum/keyhelper/keyhelper.c"
NAME="${ADVERSUM_SIGN_IDENTITY:-Adversum Dev}"
IDENTIFIER="io.adversum.kimaitray.keyhelper"
FLAGS="-arch arm64 -arch x86_64 -mmacosx-version-min=10.15 -O2 -Wall"

if [ -d /Volumes/AdversumDev/.cache ]; then
  CACHE="/Volumes/AdversumDev/.cache/keyhelper"
else
  CACHE="$REPO/src-tauri/target/keyhelper"
fi
HELPER="$CACHE/kimaitray-keyhelper"
STAMP="$CACHE/kimaitray-keyhelper.stamp"

signer="$(security find-certificate -c "$NAME" -Z 2>/dev/null | awk '/SHA-1 hash:/ {print tolower($NF)}')"
[ -n "$signer" ] || { echo "No certificate \"$NAME\" in the keychain." >&2; exit 1; }
wanted="$( (cat "$SOURCE"; echo "$signer $IDENTIFIER $FLAGS") | shasum -a 256 | cut -d' ' -f1)"

if [ -x "$HELPER" ] && [ "$(cat "$STAMP" 2>/dev/null)" = "$wanted" ] &&
  codesign --verify --strict "$HELPER" 2>/dev/null; then
  echo "$HELPER"
  exit 0
fi

echo "==> Building a NEW key helper. macOS will ask for the keychain once more" >&2
echo "    at the next start of the app: enter the password, \"Always Allow\"." >&2
mkdir -p "$CACHE"
# shellcheck disable=SC2086
clang $FLAGS -DSIGNER_HASH="\"$signer\"" \
  -framework Security -framework CoreFoundation -o "$HELPER" "$SOURCE" >&2
codesign --force --options runtime -i "$IDENTIFIER" -s "$NAME" "$HELPER" >&2
printf '%s' "$wanted" > "$STAMP"
echo "$HELPER"
