#!/usr/bin/env bash
# Record a real multiplayer-cli session and render it to an animated SVG.
#
# The point is that nobody hand-draws the demo. This drives the actual binary
# in a real terminal, types real commands into it, and renders whatever came
# back — so the picture in the README cannot quietly stop matching the tool.
#
# Needs `script` (util-linux) for the pty. Run from the repo root:
#   ./scripts/record-demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/docs/media/session.svg}"
ROWS=30
COLS=118

work="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$work"' EXIT
[ -n "${KEEP:-}" ] && echo "capture kept in $work" >&2

# A throwaway repository, so the race has somewhere real to branch from.
repo="$work/demo"
mkdir -p "$repo"
git -C "$repo" init -q -b main
git -C "$repo" config user.email demo@example.invalid
git -C "$repo" config user.name demo
printf 'export function fetchPage(n) {\n  return http.get(`/items?page=${n}`);\n}\n' > "$repo/pagination.js"
git -C "$repo" add -A
git -C "$repo" commit -qm "pagination"

# A stand-in coding CLI. Real backends need a real subscription and would make
# the recording different every time; this makes it the same every time while
# still going through the actual process driver, profile and event mapping.
cat > "$work/agent" <<'STUB'
#!/usr/bin/env bash
prompt="${!#}"
say() { python3 -c "import json,sys;print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':sys.argv[1]}}))" "$1"; }
echo '{"type":"thread.started","thread_id":"th_demo"}'
if [[ "$prompt" == *"room decided"* || "$prompt" == *"did not pick"* ]]; then
  printf 'export function fetchPage(n) {\n  return http.get(`/items?page=${n}&v=2`);\n}\n' > pagination.js
  say 'Migrating. v1 callers get a deprecation warning for one release.'
else
  say $'Two ways to do this, and they are not equivalent.\n[[crossroads]]\n? Should the v1 pagination API keep working after this change?\n- Shim it — keep v1 alive behind an adapter, nobody has to move\n- Migrate — drop v1 and update every caller in one go\n[[/crossroads]]'
fi
echo '{"type":"turn.completed","usage":{"output_tokens":42}}'
STUB
chmod +x "$work/agent"

fifo="$work/keys"
mkfifo "$fifo"

( cd "$repo" && script -q -e --log-out "$work/raw" --log-timing "$work/timing" \
    -c "stty rows $ROWS cols $COLS; node '$ROOT/dist/src/cli.js' share \
        --local --policy solo --room amber-ridge-04 --no-transcript --lanes 0 \
        --backend codex --backend-bin '$work/agent'" < "$fifo" >/dev/null 2>&1 ) &
pid=$!

exec 3> "$fifo"
type_line() { printf '%s\n' "$1" >&3; sleep "${2:-3}"; }

sleep 3.5
type_line 'rewrite the pagination layer to support cursors' 5
type_line '/fork' 3
type_line '/y #3' 6
type_line '/quit' 1.5
exec 3>&-
wait "$pid" 2>/dev/null || true

node "$ROOT/scripts/make-screen-svg.mjs" "$work/raw" "$work/timing" "$OUT" --rows "$ROWS" --cols "$COLS"
