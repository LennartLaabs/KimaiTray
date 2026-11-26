#!/bin/sh
# ADVERSUM: builds the helper that asks Apple's on-device language model
# (extract.swift) and prints its path. Prints nothing when it cannot be
# built: the Foundation Models framework needs the macOS 26 SDK, which comes
# with Xcode 26 or "Command Line Tools for Xcode 26". The app then simply has
# no on-device model and uses its rules.
#
# Never fails the build it is called from.
set -u
cd "$(dirname "$0")"

sdk="$(xcrun --show-sdk-path 2>/dev/null || true)"
if [ -z "$sdk" ] || [ ! -d "$sdk/System/Library/Frameworks/FoundationModels.framework" ]; then
  echo "NOTE: no Foundation Models in the installed SDK ($(xcrun --show-sdk-version 2>/dev/null || echo none)); on-device helper skipped." >&2
  exit 0
fi

cache="${ADVERSUM_CACHE:-/Volumes/AdversumDev/.cache}/extract"
mkdir -p "$cache" || exit 0
stamp="$(shasum -a 256 extract.swift | cut -d' ' -f1)"
out="$cache/kimaitray-extract"
if [ -x "$out" ] && [ "$(cat "$cache/stamp" 2>/dev/null)" = "$stamp" ]; then
  echo "$out"
  exit 0
fi
if xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 extract.swift -o "$out" 2>"$cache/build.log"; then
  echo "$stamp" > "$cache/stamp"
  echo "$out"
else
  echo "NOTE: the on-device helper did not compile; see $cache/build.log." >&2
fi
exit 0
