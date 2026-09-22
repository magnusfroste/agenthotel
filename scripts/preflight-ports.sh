#!/bin/sh
# Are 80 and 443 free? Its own file so it can be tested — this check has been
# wrong twice, in opposite directions, and both times the installer was the
# only place it ran.
#
#   0  free
#   1  in use
#   2  cannot tell (no ss, no lsof)
port_in_use() {
  port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q . && return 1 || return 0
  elif command -v lsof >/dev/null 2>&1; then
    lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1 && return 1 || return 0
  fi
  return 2
}

# Checks every port and returns non-zero if any of them is unusable, with the
# reason on stderr. Never aborts the caller by itself: under `set -e` a bare
# call that returns non-zero kills the script, which is exactly how a free port
# came to abort a fresh install for three days.
check_ports() {
  for port in "$@"; do
    status=0
    port_in_use "$port" || status=$?
    case "$status" in
      1)
        echo "Error: something is already running on port $port" >&2
        echo "  AgentHotel needs both 80 and 443 for Caddy and automatic HTTPS." >&2
        echo "  Find it with: ss -ltnp 'sport = :$port'" >&2
        return 1 ;;
      2)
        echo "Error: cannot check whether port $port is free — neither ss nor lsof is installed." >&2
        echo "  Install iproute2 and run again; guessing here is how a broken install starts." >&2
        return 1 ;;
    esac
  done
  return 0
}
