#!/bin/bash
set -e

export DEBIAN_FRONTEND=noninteractive

echo "╔════════════════════════════════════════╗"
echo "║     AgentHotel Installer v1.0.0       ║"
echo "║   Easypanel for AI Agents             ║"
echo "╚════════════════════════════════════════╝"
echo ""

if [ "$(id -u)" != "0" ]; then
  echo "Error: you must be root to execute this script" >&2
  exit 1
fi

if [ "$(uname)" = "Darwin" ]; then
  echo "Error: MacOS is not supported" >&2
  exit 1
fi

if [ -f /.dockerenv ]; then
  echo "Error: running inside a container is not supported" >&2
  exit 1
fi

# Port check that works on a FRESH host, which is the only place it matters.
# This used to call lsof, which the script installs sixty lines further down —
# so on a clean VPS the command did not exist, the test failed, and the check
# passed silently. A provider image shipping nginx on port 80 then got past it
# and surfaced later as a confusing Caddy failure.
#
# ss ships with iproute2 and is present on essentially every modern
# Debian/Ubuntu; lsof is the fallback. If neither exists we say so rather than
# pretending the port is free.
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q .
  elif command -v lsof >/dev/null 2>&1; then
    lsof -i ":$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    echo "Warning: neither ss nor lsof available — cannot check port $port" >&2
    return 1
  fi
}

for port in 80 443; do
  if port_in_use "$port"; then
    echo "Error: something is already running on port $port" >&2
    echo "  AgentHotel needs both 80 and 443 for Caddy and automatic HTTPS." >&2
    echo "  Find it with: ss -ltnp 'sport = :$port'" >&2
    exit 1
  fi
done

command_exists() {
  command -v "$@" > /dev/null 2>&1
}

INSTALL_DIR="/opt/agenthotel"
GITHUB_REPO="https://github.com/magnusfroste/agenthotel.git"

echo ""
echo "Installing Docker..."
if command_exists docker; then
  echo "✓ Docker already installed"
else
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  echo "✓ Docker installed"
fi

echo ""
echo "Installing Git..."
if command_exists git; then
  echo "✓ Git already installed"
else
  apt-get update
  apt-get install -y git
  echo "✓ Git installed"
fi

echo ""
echo "Installing lsof..."
if command_exists lsof; then
  echo "✓ lsof already installed"
else
  apt-get install -y lsof
  echo "✓ lsof installed"
fi

echo ""
echo "Checking swap..."
# Agent memory limits are ceilings, not reservations, so a busy fleet can be
# overcommitted by design. With swap that means "slow for a moment"; without it
# the kernel kills an agent outright. A small VPS almost never ships with swap,
# so create some — but never touch a host that already has it, and never fail
# the install over it.
if [ "$(swapon --show --noheadings 2>/dev/null | wc -l)" -gt 0 ]; then
  echo "✓ Swap already configured — leaving it alone"
elif [ -e /swapfile ]; then
  echo "✓ /swapfile already exists — leaving it alone"
elif [ "${AGENTHOTEL_SKIP_SWAP:-}" = "1" ]; then
  echo "• Skipped (AGENTHOTEL_SKIP_SWAP=1)"
else
  SWAP_MB=2048
  echo "  Creating a ${SWAP_MB}MB swapfile (set AGENTHOTEL_SKIP_SWAP=1 to skip)"
  if (fallocate -l "${SWAP_MB}M" /swapfile 2>/dev/null || \
      dd if=/dev/zero of=/swapfile bs=1M count="$SWAP_MB" status=none) &&
     chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    # Swap as an emergency buffer, not routine paging.
    sysctl -w vm.swappiness=10 >/dev/null 2>&1 || true
    grep -q '^vm.swappiness' /etc/sysctl.conf 2>/dev/null || echo 'vm.swappiness=10' >> /etc/sysctl.conf
    echo "✓ Swap enabled and persisted"
  else
    rm -f /swapfile
    echo "⚠ Could not create swap — continuing without it."
    echo "  Some hosts (containers, certain VPS images) disallow it. The panel"
    echo "  will show a warning on the System page while swap is missing."
  fi
fi

echo ""
echo "Setting up AgentHotel..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -f "$SCRIPT_DIR/docker-compose.yml" ] && [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
  echo "Using local installation from $SCRIPT_DIR..."
  cp -r "$SCRIPT_DIR" "$INSTALL_DIR"
elif [ -d "$INSTALL_DIR" ]; then
  echo "Existing installation found. Updating..."
  cd "$INSTALL_DIR"
  git pull
else
  git clone "$GITHUB_REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

echo ""
echo "Building and starting AgentHotel..."
# Bake the checked-out commit into the image so the panel reports the version it
# is actually running (and can tell when a real update is available).
GIT_COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
docker compose build --build-arg GIT_COMMIT="$GIT_COMMIT"
docker compose up -d

echo ""
echo "Waiting for services to start..."
sleep 10

SERVER_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "╔════════════════════════════════════════╗"
echo "║     Installation Complete!             ║"
echo "╠════════════════════════════════════════╣"
echo "║                                        ║"
echo "║  Open in browser:                      ║"
echo "║  http://$SERVER_IP                     ║"
echo "║                                        ║"
echo "║  Create your admin account on first    ║"
echo "║  visit. You can configure a domain     ║"
echo "║  later in Settings.                    ║"
echo "║                                        ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Useful commands:"
echo "  cd $INSTALL_DIR"
echo "  docker compose logs -f"
echo "  docker compose restart"
echo "  docker compose down"
echo ""
