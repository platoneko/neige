#!/usr/bin/env bash
# Reap orphan neige-session-daemon processes and their leftover sock files.
# Default: dry-run. Pass --go to actually SIGTERM (5s grace) then SIGKILL.
#
# Orphan definition (must match ALL to be killed):
#   - daemon has no alive claude descendant (daemon → sh -c zsh → zsh → claude)
#   - OR its cmdline is empty / has no --id (broken)
#
# Any daemon with an alive claude is left untouched. Orphan sock files (nothing
# is listening on them) are removed unconditionally.
set -euo pipefail

SOCK_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/neige"

# Ask the kernel who we are rather than the environment. cron runs without
# USER set, and `set -u` turned every `$USER` expansion below into a failing
# command substitution — silently, because each was wrapped in `|| true`. The
# daemon list came back empty, which made every socket look unreferenced, and
# the nightly --go run deleted the sockets of healthy live sessions. Those
# sessions stay up but can never be reattached, so the next server restart
# abandons them with their agents still running.
UID_NUM=$(id -u)

# Without ss(8) we cannot tell a live socket from a stale one, and guessing
# wrong costs a live session. Refuse instead.
command -v ss >/dev/null || {
  echo "ss(8) not found; refusing to classify sockets" >&2
  exit 1
}

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
for pid in $(pgrep -u "$UID_NUM" -f 'neige-session-daemon ' 2>/dev/null || true); do
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

# Sockets someone is actually listening on. This is the authoritative test and
# it is deliberately not derived from the daemon list above: a socket that
# accepts connections is in use no matter what process enumeration thinks, and
# that independence is the point — deleting a live session's socket is
# unrecoverable, while leaving a stale file costs nothing until the next run.
mapfile -t LISTENING_SOCKS < <(
  ss -xl 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i ~ "^/") { print $i; break }}' | sort -u
)
is_referenced() {
  local s=$1 r
  for r in "${LISTENING_SOCKS[@]}"; do [ "$r" = "$s" ] && return 0; done
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
