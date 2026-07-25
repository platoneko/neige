#!/usr/bin/env bash
# Report on neige-session-daemon health without touching anything.
#
# A daemon is HEALTHY when it owns a live unix sock AND has an alive claude
# grandchild-of-grandchild (daemon → sh -c zsh → zsh → claude). Any other
# combination is orphan-ish and probably safe to reap.
set -euo pipefail

SOCK_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/neige"

classify() {
  local pid=$1
  local cmdline sock cwd id
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  id=$(echo "$cmdline" | grep -oE -- '--id [a-f0-9-]+' | awk '{print $2}')
  sock=$(echo "$cmdline" | grep -oE -- '--sock [^ ]+' | awk '{print $2}')
  cwd=$(echo "$cmdline" | grep -oE -- '--cwd [^ ]+' | awk '{print $2}')

  local sock_state='gone'
  [ -n "$sock" ] && [ -S "$sock" ] && sock_state='ok'

  local claude_state='none' claude_pid=''
  for c in $(pgrep -P "$pid" 2>/dev/null); do
    for gc in $(pgrep -P "$c" 2>/dev/null); do
      for ggc in $(pgrep -P "$gc" 2>/dev/null); do
        [ "$(cat /proc/$ggc/comm 2>/dev/null)" = 'claude' ] || continue
        local argv0
        argv0=$(head -c 100 "/proc/$ggc/cmdline" 2>/dev/null | tr '\0' '\n' | head -1)
        [ "${argv0##*/}" = 'claude' ] || continue
        claude_state='alive'
        claude_pid=$ggc
      done
    done
  done

  local verdict
  if [ "$sock_state" = 'ok' ] && [ "$claude_state" = 'alive' ]; then
    verdict='healthy'
  elif [ -z "$cmdline" ] || [ -z "$id" ]; then
    verdict='broken'
  else
    verdict='orphan'
  fi

  printf '%-8s  %-8s  %-6s  %-14s  %-70s  %s\n' \
    "$pid" "$verdict" "$sock_state" "$claude_state${claude_pid:+ ($claude_pid)}" "${cwd:--}" "${id:0:8}"
}

echo '=== daemons ==='
printf '%-8s  %-8s  %-6s  %-14s  %-70s  %s\n' 'PID' 'VERDICT' 'SOCK' 'CLAUDE' 'CWD' 'ID'
printf '%-8s  %-8s  %-6s  %-14s  %-70s  %s\n' '--------' '--------' '------' '--------------' '----' '--'
mapfile -t DAEMONS < <(pgrep -u "$USER" -f 'neige-session-daemon ' 2>/dev/null || true)
for pid in "${DAEMONS[@]}"; do classify "$pid"; done | sort -k2,2 -k5,5

echo
echo '=== summary ==='
total=${#DAEMONS[@]}
sock_count=$(ls "$SOCK_DIR"/*.sock 2>/dev/null | wc -l || echo 0)
referenced=$(for p in "${DAEMONS[@]}"; do
  tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -oE -- '--sock [^ ]+' | awk '{print $2}'
done | sort -u | wc -l)
orphan_socks=$((sock_count - referenced))

echo "  daemons total       : $total"
echo "  socks in $SOCK_DIR : $sock_count"
echo "  socks referenced    : $referenced"
echo "  orphan sock files   : $orphan_socks"
