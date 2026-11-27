#!/bin/sh
# ADVERSUM: builds the helper program for the local language model
# (src-tauri/llm-helper, llama.cpp) and prints its path.
#
#   build.sh              for this Mac's processor
#   build.sh universal    for Apple Silicon and Intel in one file (for the DMG)
#
# The first build compiles llama.cpp and takes a few minutes; later ones are
# quick. Prints nothing and returns 0 when the build fails, so the app is
# still built: it then has no local language model and says so.
set -u
cd "$(dirname "$0")/../../../src-tauri/llm-helper"
. ../../scripts/adversum/env.sh 2>/dev/null || true

build() {
  if [ -n "$1" ]; then
    cargo build --release --target "$1" >&2 || return 1
    echo "target/$1/release/kimaitray-llm"
  else
    cargo build --release >&2 || return 1
    echo "target/release/kimaitray-llm"
  fi
}

if [ "${1:-}" = "universal" ]; then
  arm="$(build aarch64-apple-darwin)" && intel="$(build x86_64-apple-darwin)" || {
    echo "NOTE: the language model helper did not build; the app is built without it." >&2
    exit 0
  }
  mkdir -p target/universal
  lipo -create "$arm" "$intel" -output target/universal/kimaitray-llm || exit 0
  echo "$PWD/target/universal/kimaitray-llm"
else
  out="$(build "")" || {
    echo "NOTE: the language model helper did not build; the app is built without it." >&2
    exit 0
  }
  echo "$PWD/$out"
fi
