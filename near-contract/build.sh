#!/usr/bin/env bash
# Builds and tests the contract.
#
# On Windows there is no MSVC linker in this environment, so the Linux
# toolchain inside WSL does the work:
#
#   wsl -d Ubuntu -- bash /mnt/c/.../near-contract/build.sh check
#
# Commands: check | test | wasm | fmt | clippy | all
set -euo pipefail

# A non-login shell from Windows does not pick up the cargo env.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$self")"

# Keep build artefacts off the Windows mount; 9p is far too slow for a target dir.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.wincut-target}"

cmd="${1:-all}"

case "$cmd" in
  check)   cargo check --all-targets --message-format short ;;
  test)    cargo test --message-format short ;;
  wasm)
    cargo build --release --target wasm32-unknown-unknown
    out="$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/wincut.wasm"
    mkdir -p ./out
    cp "$out" ./out/wincut.wasm
    ls -l ./out/wincut.wasm
    ;;
  fmt)     cargo fmt --all -- --check ;;
  clippy)  cargo clippy --all-targets -- -D warnings ;;
  all)
    cargo test --message-format short
    "$self" wasm
    ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
