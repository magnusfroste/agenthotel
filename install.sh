#!/bin/bash
set -e

echo "╔════════════════════════════════════════╗"
echo "║     AgentPanel Installer v1.0.0       ║"
echo "║   Easypanel for AI Agents             ║"
echo "╚════════════════════════════════════════╝"
echo ""

if [ "$EUID" -ne 0 ]; then
  echo "Error: This script must be run as root"
  exit 1
fi

INSTALL_DIR="/opt/agentpanel"
GITHUB_REPO="https://github.com/magnusfroste/agentpanel.git"

read -p "Enter your panel domain (e.g., panel.example.com): " PANEL_DOMAIN
read -p "Enter admin password: " ADMIN_PASSWORD

if [ -z "$PANEL_DOMAIN" ] || [ -z "$ADMIN_PASSWORD" ]; then
  echo "Error: Domain and password are required"
  exit 1
fi

echo ""
echo "Installing Docker..."
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
  echo "✓ Docker installed"
else
  echo "✓ Docker already installed"
fi

echo ""
echo "Installing Git..."
if ! command -v git &> /dev/null; then
  apt-get update && apt-get install -y git
  echo "✓ Git installed"
else
  echo "✓ Git already installed"
fi

echo ""
echo "Setting up AgentPanel..."
if [ -d "$INSTALL_DIR" ]; then
  echo "Existing installation found. Updating..."
  cd "$INSTALL_DIR"
  git pull
else
  git clone "$GITHUB_REPO" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

echo ""
echo "Creating .env file..."
cat > .env << EOF
PANEL_DOMAIN=$PANEL_DOMAIN
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF

echo "✓ .env created"

echo ""
echo "Building and starting AgentPanel..."
docker compose build
docker compose up -d

echo ""
echo "Waiting for services to start..."
sleep 10

echo ""
echo "╔════════════════════════════════════════╗"
echo "║     Installation Complete!             ║"
echo "╠════════════════════════════════════════╣"
echo "║                                        ║"
echo "║  Panel: https://$PANEL_DOMAIN         ║"
echo "║  User: admin                           ║"
echo "║  Password: (your admin password)       ║"
echo "║                                        ║"
echo "║  Make sure DNS points $PANEL_DOMAIN   ║"
echo "║  to this server's IP address.          ║"
echo "║                                        ║"
echo "╚════════════════════════════════════════╝"
echo ""
echo "Useful commands:"
echo "  cd $INSTALL_DIR"
echo "  docker compose logs -f"
echo "  docker compose restart"
echo "  docker compose down"
echo ""
