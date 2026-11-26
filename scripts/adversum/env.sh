#!/bin/sh
# ADVERSUM: project environment for this fork.
#
# Usage:
#   ./scripts/adversum/env.sh npm run tauri dev     # run one command
#   . ./scripts/adversum/env.sh                     # or source it into a shell
#
# What it does:
# - Puts Homebrew's keg-only Node 24 first on PATH (the system default Node
#   stays untouched) and adds ~/.cargo/bin for rustup's cargo/rustc.
# - When the APFS dev image is mounted at /Volumes/AdversumDev, keeps the
#   cargo registry and the npm cache inside the image so the internal disk
#   only holds the Rust toolchain (~/.rustup).

ADVERSUM_NODE_FORMULA="node@24"
for prefix in /opt/homebrew/opt /usr/local/opt; do
  if [ -x "${prefix}/${ADVERSUM_NODE_FORMULA}/bin/node" ]; then
    PATH="${prefix}/${ADVERSUM_NODE_FORMULA}/bin:${PATH}"
    break
  fi
done
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
