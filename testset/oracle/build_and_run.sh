#!/usr/bin/env bash
# build_and_run.sh — compile every oracle against the static libuv built in
# <project>/build and run it. Local/manual driver; the harness drives the same
# steps from a self-driven TestWorkflow (see docs/02-testset-requirements.md).
#
# Usage: bash testset/oracle/build_and_run.sh [libuv-root] [build-dir]
set -u

ORACLE_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$ORACLE_DIR/../.." && pwd)"
LIBUV_ROOT="${1:-$PROJECT_ROOT/libuv}"
BUILD_DIR="${2:-$PROJECT_ROOT/build}"

CFLAGS="-O0 -g -I $LIBUV_ROOT/include -I $LIBUV_ROOT/src -I $ORACLE_DIR"
SYSLIBS="-lpsapi -luser32 -ladvapi32 -liphlpapi -luserenv -lws2_32 -ldbghelp -lole32 -lshell32"

if [ ! -f "$BUILD_DIR/libuv.a" ]; then
  echo "missing $BUILD_DIR/libuv.a — configure and build the static library first" >&2
  exit 2
fi

failures=0
for src in "$ORACLE_DIR"/oracle_*.c; do
  name="$(basename "$src" .c)"
  exe="$BUILD_DIR/$name.exe"
  # shellcheck disable=SC2086
  if ! gcc $CFLAGS "$src" "$BUILD_DIR/libuv.a" -o "$exe" $SYSLIBS; then
    echo "$name: COMPILE FAILED"
    failures=$((failures + 1))
    continue
  fi
  win_exe="$(cd "$(dirname "$exe")" && pwd)\\$(basename "$exe")"
  out="$(cmake -E env "$win_exe" 2>&1)"
  rc=$?
  printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    echo "$name: EXIT $rc"
    failures=$((failures + 1))
  fi
done

echo "oracles_failed=$failures"
exit "$failures"
