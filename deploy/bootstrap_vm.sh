#!/usr/bin/env bash
# Run on a fresh Ubuntu VM as root (or with sudo). Installs Docker and starts ADHERE+.
set -e
DOMAIN="${1:?Usage: bootstrap_vm.sh <domain>   (e.g. 203-0-113-9.sslip.io or partograph.epichealthsystems.org)}"
apt-get update -y && apt-get install -y ca-certificates curl git
install -m0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
# project is expected in the current directory (scp or git clone it here first)
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s#^SITE_DOMAIN=.*#SITE_DOMAIN=${DOMAIN}#" .env
  sed -i "s#change-me-strong-root#$(openssl rand -hex 16)#" .env
  sed -i "s#change-me-strong#$(openssl rand -hex 16)#" .env
  echo "Generated .env with strong random DB passwords and SITE_DOMAIN=${DOMAIN}"
fi
docker compose --env-file .env -f docker-compose.prod.yml up -d --build
echo "Done. App will be live at https://${DOMAIN} once DNS points here and Caddy issues a certificate."
