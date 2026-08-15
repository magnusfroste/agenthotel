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

if lsof -i :80 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Error: something is already running on port 80" >&2
  exit 1
fi

if lsof -i :443 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Error: something is already running on port 443" >&2
  exit 1
fi

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
docker compose build
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
