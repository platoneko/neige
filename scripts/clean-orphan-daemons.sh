#!/usr/bin/env bash
# Reap orphan neige-session-daemon processes and their leftover sock files.
# Default: dry-run. Pass --go to actually SIGTERM (5s grace) then SIGKILL.
#
# Orphan definition: nothing is listening on the daemon's socket, so no server
# can reach it again and nothing inside it can ever be displayed or attached to.
# A daemon whose socket still accepts connections is in use and is never
# touched — whether it holds an agent, a plain shell, or an ssh session.
#
# This used to key on "has no alive claude descendant", which is wrong in both
# directions: it spared unreachable daemons because an agent was still running
# inside them (the leak this script exists to clean), and it condemned live
# sessions running anything that is not claude — a bare zsh, grok, gcloud.
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

# Pids that actually hold a listening socket. Asking which daemon owns the
# socket, not which daemon's cmdline names the path: a restart binds the same
# path again and orphans the previous owner, so several daemons carry the same
# --sock and only one of them is reachable. That is the exact shape of the leak
# this script is cleaning, so path matching would spare every instance of it.
mapfile -t LISTENING_PIDS < <(
  ss -xlp 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
)
owns_listener() {
  local p=$1 r
  for r in "${LISTENING_PIDS[@]}"; do [ "$r" = "$p" ] && return 0; done
  return 1
}

# One question per daemon: can a server still reach it?
KILL_PIDS=()
KEEP_PIDS=()
for pid in $(pgrep -u "$UID_NUM" -f 'neige-session-daemon ' 2>/dev/null || true); do
  if owns_listener "$pid"; then
    KEEP_PIDS+=("$pid")
  else
    KILL_PIDS+=("$pid")
  fi
done

echo "== KEEP daemons (${#KEEP_PIDS[@]}) — reachable, in use =="
for pid in "${KEEP_PIDS[@]}"; do
  cwd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -oE -- '--cwd [^ ]+' | awk '{print $2}')
  echo "  $pid  cwd=$cwd"
done

echo
echo "== KILL daemons (${#KILL_PIDS[@]}) — unreachable =="
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
  # Take each session down with its daemon. Signalling the daemon pid alone
  # leaves the shell — and the agent inside it — reparented to init, still
  # holding the memory this reap exists to release; the daemon is a few MB, the
  # agent is hundreds. The daemon's direct child is the PTY session leader, so
  # its pid is the session id every process in that session shares.
  VICTIMS=("${KILL_PIDS[@]}")

  # The doomed sessions, named by their leader — each daemon's direct child.
  declare -A DOOMED=()
  for pid in "${KILL_PIDS[@]}"; do
    leader=$(pgrep -P "$pid" 2>/dev/null | head -1 || true)
    if [ -n "$leader" ]; then DOOMED[$leader]=1; fi
  done

  # One pass over /proc, parsed in the shell. Scanning it once per daemon and
  # shelling out to sed+awk per process meant tens of thousands of forks, which
  # is slow enough to fail outright — and it failed *after* printing the plan,
  # so the reap looked like it had run.
  if [ ${#DOOMED[@]} -gt 0 ]; then
    for f in /proc/[0-9]*/stat; do
      # Processes come and go while we walk /proc; a stat file that vanished
      # between the glob and the open is not an error worth aborting the reap
      # for. `$(<"$f")` cannot swallow that failure, `read` can.
      read -r line < "$f" 2>/dev/null || continue
      # Fields after the parenthesised comm are state, ppid, pgrp, session.
      # Split on the last ')' because comm can contain spaces and parens.
      read -r -a fields <<< "${line##*) }"
      if [ -n "${DOOMED[${fields[3]}]:-}" ]; then
        p=${f#/proc/}
        VICTIMS+=("${p%/stat}")
      fi
    done
  fi

  echo "sending SIGTERM to ${#KILL_PIDS[@]} daemons and ${#VICTIMS[@]} session processes..."
  kill -TERM "${VICTIMS[@]}" 2>/dev/null || true
  sleep 5
  STILL=()
  for pid in "${VICTIMS[@]}"; do
    if [ -d "/proc/$pid" ]; then STILL+=("$pid"); fi
  done
  if [ ${#STILL[@]} -gt 0 ]; then
    echo "SIGKILL survivors: ${#STILL[@]}"
    kill -KILL "${STILL[@]}" 2>/dev/null || true
  fi
fi

if [ ${#ORPHAN_SOCKS[@]} -gt 0 ]; then
  echo "removing ${#ORPHAN_SOCKS[@]} orphan sock files..."
  rm -f "${ORPHAN_SOCKS[@]}" || true
fi

echo "done."
exit 0
