#!/usr/bin/env bash
#
# Proves a compiled binary actually runs, on the machine it was built for.
#
# `bun build --compile` succeeding says nothing about whether the result works: the
# JSON schemas are pulled in through import attributes and `--bytecode` rewrites the
# whole module graph, so the ways this can break are exactly the ways a bundler
# breaks things — at startup, on the first schema validation, never at build time.
#
# Every step here is offline. CI runs it with RARN_NO_NETWORK=1 set, and the last
# check confirms the binary honours that rather than quietly reaching out.
#
#   scripts/smoke.sh dist/rarn-windows-x64.exe
set -euo pipefail

BIN=${1:?사용법: scripts/smoke.sh <바이너리 경로>}
[ -x "$BIN" ] || [ -f "$BIN" ] || { echo "smoke: $BIN 이 없다" >&2; exit 1; }
BIN=$(cd "$(dirname "$BIN")" && pwd)/$(basename "$BIN")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; exit 1; }

echo "smoke: $BIN"

# 1. It starts at all.
version=$("$BIN" --version)
case $version in
  *[0-9].[0-9]*) pass "--version -> $version" ;;
  *) fail "--version 이 버전 같지 않다: $version" ;;
esac

# 2. Every command is wired. `publish` is last-registered, so its presence means
#    the whole command table survived bundling.
help=$("$BIN" --help)
for command in init add install remove up list why dedupe search info outdated cache doctor login logout whoami pack publish; do
  case $help in
    *" $command"*) ;;
    *) fail "--help 에 $command 가 없다" ;;
  esac
done
pass "--help 에 18개 명령이 전부 있다"

# 3. Writing a manifest exercises ajv against the embedded schema — the single most
#    likely thing to be missing from a compiled binary.
"$BIN" init -y --cwd "$WORK" >/dev/null
[ -f "$WORK/rarn.json" ] || fail "init 이 rarn.json 을 쓰지 않았다"
grep -q '"name"' "$WORK/rarn.json" || fail "rarn.json 에 name 이 없다"
pass "init -y -> rarn.json"

# 4. Reading it back validates the schema in the other direction, and pack walks the
#    project the way a real publish would.
#
#    The name is rewritten first. `init` names a project after its folder, which is
#    a bare name — deliberate, since a game is never published — while `pack` renders
#    a wally.toml and that needs '@scope/name'. That collision is the first thing a
#    real user hits, so it is checked before being stepped around.
scoped=$("$BIN" pack --list --cwd "$WORK" 2>&1 || true)
case $scoped in
  *RN0625*) pass "스코프 없는 이름을 RN0625 로 설명한다" ;;
  *) fail "RN0625 를 기대했는데: $scoped" ;;
esac
cat > "$WORK/rarn.json" <<'MANIFEST'
{
  "name": "@rarn-smoke/demo",
  "version": "0.1.0",
  "realm": "shared",
  "packageDir": "RARN_MODULE",
  "dependencies": {}
}
MANIFEST
printf 'return {}\n' > "$WORK/init.luau"
listing=$("$BIN" pack --list --cwd "$WORK")
case $listing in
  *init.luau*) ;;
  *) fail "pack --list 에 init.luau 가 없다" ;;
esac
case $listing in
  *wally.toml*) ;;
  *) fail "pack --list 에 생성된 wally.toml 이 없다" ;;
esac
pass "pack --list"

# 5. A failure has to fail. A binary that exits 0 on everything satisfies every
#    check above. The code is asserted rather than just the exit status — "not zero"
#    is satisfied by any failure, including the network block set below, which would
#    make this pass for a reason it was not testing.
failure=$("$BIN" list --cwd "$WORK" 2>&1 || true)
case $failure in
  *RN0510*) pass "락파일 없는 list 가 RN0510 으로 실패한다" ;;
  *) fail "RN0510 을 기대했는데: $failure" ;;
esac
if "$BIN" list --cwd "$WORK" >/dev/null 2>&1; then
  fail "실패해야 할 명령이 0 으로 끝났다"
fi

# 6. The offline guard survived compilation. Without this the smoke job would be the
#    one place CI still talks to api.wally.run.
if [ "${RARN_NO_NETWORK:-}" != "" ] && [ "${RARN_NO_NETWORK:-0}" != "0" ]; then
  blocked=$("$BIN" search promise --cwd "$WORK" 2>&1 || true)
  case $blocked in
    *RN0130*) pass "RARN_NO_NETWORK 가 바이너리에서도 동작한다" ;;
    *) fail "네트워크가 차단됐어야 하는데 RN0130 이 안 나왔다: $blocked" ;;
  esac
else
  echo "  skip RARN_NO_NETWORK 미설정"
fi

echo "smoke: 전부 통과"
