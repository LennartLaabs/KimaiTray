#!/bin/sh
# ADVERSUM: project environment for this fork.
#
# Usage:
#   ./scripts/adversum/env.sh npm run tauri dev     # run one command
#   . ./scripts/adversum/env.sh                     # or source it into a shell
#
# What it does:
# - Adds ~/.cargo/bin to PATH for rustup's cargo and rustc. Node is the
#   system default (Homebrew `node`); package.json `engines` says which
#   versions are supported.
# - When the APFS dev image is mounted at /Volumes/AdversumDev, keeps the
#   cargo registry and the npm cache inside the image so the internal disk
#   only holds the Rust toolchain (~/.rustup).

if [ -d "${HOME}/.cargo/bin" ]; then
  PATH="${HOME}/.cargo/bin:${PATH}"
fi
export PATH

if [ -d /Volumes/AdversumDev ]; then
  export CARGO_HOME="/Volumes/AdversumDev/.cache/cargo-home"
  export npm_config_cache="/Volumes/AdversumDev/.cache/npm"
fi

# Executed (not sourced) with arguments: run the command in this environment.
case "${0##*/}" in
  env.sh)
    if [ "$#" -gt 0 ]; then
      exec "$@"
    fi
    ;;
esac
