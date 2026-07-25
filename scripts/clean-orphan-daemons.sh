#!/usr/bin/env bash
# Reap orphan neige-session-daemon processes and their leftover sock files.
# Default: dry-run. Pass --go to actually SIGTERM (5s grace) then SIGKILL.
#
# Orphan definition (must match ALL to be killed):
#   - daemon has no alive claude descendant (daemon → sh -c zsh → zsh → claude)
#   - OR its cmdline is empty / has no --id (broken)
#
# Any daemon with an alive claude is left untouched. Orphan sock files (no
# daemon in ps references them) are removed unconditionally.
set -euo pipefail

SOCK_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/neige"

has_alive_claude() {
  local pid=$1
  for c in $(pgrep -P "$pid" 2>/dev/null); do
    for gc in $(pgrep -P "$c" 2>/dev/null); do
      for ggc in $(pgrep -P "$gc" 2>/dev/null); do
        [ "$(cat /proc/$ggc/comm 2>/dev/null)" = 'claude' ] || continue
        local argv0
        argv0=$(head -c 100 "/proc/$ggc/cmdline" 2>/dev/null | tr '\0' '\n' | head -1)
        [ "${argv0##*/}" = 'claude' ] && return 0
      done
    done
  done
  return 1
}

KILL_PIDS=()
KEEP_PIDS=()
for pid in $(pgrep -u "$USER" -f 'neige-session-daemon ' 2>/dev/null || true); do
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  id=$(echo "$cmdline" | grep -oE -- '--id [a-f0-9-]+' | awk '{print $2}')
  if [ -z "$cmdline" ] || [ -z "$id" ]; then
    KILL_PIDS+=("$pid")
    continue
  fi
  if has_alive_claude "$pid"; then
    KEEP_PIDS+=("$pid")
  else
    KILL_PIDS+=("$pid")
  fi
done

# Referenced socks (those still owned by any daemon in ps)
mapfile -t REFERENCED_SOCKS < <(
  for p in $(pgrep -u "$USER" -f 'neige-session-daemon ' 2>/dev/null || true); do
    tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -oE -- '--sock [^ ]+' | awk '{print $2}'
  done | sort -u
)
is_referenced() {
  local s=$1 r
  for r in "${REFERENCED_SOCKS[@]}"; do [ "$r" = "$s" ] && return 0; done
  return 1
}
ORPHAN_SOCKS=()
for f in "$SOCK_DIR"/*.sock; do
  [ -e "$f" ] || continue
  is_referenced "$f" || ORPHAN_SOCKS+=("$f")
done

echo "== KEEP daemons (${#KEEP_PIDS[@]}) — have alive claude =="
for pid in "${KEEP_PIDS[@]}"; do
  cwd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -oE -- '--cwd [^ ]+' | awk '{print $2}')
  echo "  $pid  cwd=$cwd"
done

echo
echo "== KILL daemons (${#KILL_PIDS[@]}) — no claude =="
for pid in "${KILL_PIDS[@]}"; do
  cwd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -oE -- '--cwd [^ ]+' | awk '{print $2}')
  age=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
  echo "  $pid  age=$age  cwd=${cwd:-(broken)}"
done

echo
echo "== REMOVE orphan sock files (${#ORPHAN_SOCKS[@]}) =="
if [ "${#ORPHAN_SOCKS[@]}" -gt 0 ]; then
  printf '  %s\n' "${ORPHAN_SOCKS[@]:0:20}"
  [ "${#ORPHAN_SOCKS[@]}" -gt 20 ] && echo "  ... and $((${#ORPHAN_SOCKS[@]} - 20)) more"
fi

if [ "${1:-}" != "--go" ]; then
  echo
  echo "dry-run only. Re-run with --go to SIGTERM (5s grace) → SIGKILL, and rm orphan socks."
  exit 0
fi

if [ ${#KILL_PIDS[@]} -gt 0 ]; then
  echo
  echo "sending SIGTERM to ${#KILL_PIDS[@]} daemons..."
  kill -TERM "${KILL_PIDS[@]}" 2>/dev/null || true
  sleep 5
  STILL=()
  for pid in "${KILL_PIDS[@]}"; do
    if [ -d "/proc/$pid" ]; then STILL+=("$pid"); fi
  done
  if [ ${#STILL[@]} -gt 0 ]; then
    echo "SIGKILL survivors: ${STILL[*]}"
    kill -KILL "${STILL[@]}" 2>/dev/null || true
  fi
fi

if [ ${#ORPHAN_SOCKS[@]} -gt 0 ]; then
  echo "removing ${#ORPHAN_SOCKS[@]} orphan sock files..."
  rm -f "${ORPHAN_SOCKS[@]}" || true
fi

echo "done."
exit 0
