#!/usr/bin/env bash
# Ubuntu 22.04 / 20.04 server setup for Ozawa Traders site
# Run as: sudo bash setup-server.sh
set -euo pipefail

APP_DIR=/var/www/ozawatraders
LOG_DIR=/var/log/ozawatraders
DOMAIN=ozawatraders.org
WWW_DOMAIN=www.ozawatraders.org
EMAIL=info@ozawatraders.org   # for Let's Encrypt notifications

if [[ "$EUID" -ne 0 ]]; then
    echo "Run as root: sudo bash $0"
    exit 1
fi

echo "==> Updating apt..."
apt-get update -y
apt-get upgrade -y

echo "==> Installing Node.js 20 LTS..."
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
node -v && npm -v

echo "==> Installing Nginx, Certbot, build tools, ufw, git..."
apt-get install -y nginx certbot python3-certbot-nginx build-essential git ufw rsync

echo "==> Installing PM2 globally..."
npm install -g pm2

echo "==> Creating app directories..."
mkdir -p "$APP_DIR" "$LOG_DIR" /var/www/letsencrypt
chown -R www-data:www-data "$LOG_DIR"

echo "==> Configuring firewall..."
ufw allow OpenSSH || true
ufw allow 'Nginx Full' || true
ufw --force enable || true

echo "==> Stopping any existing webservers (Apache/Nginx) listening on 80..."
systemctl stop apache2 2>/dev/null || true
systemctl disable apache2 2>/dev/null || true

echo "==> Setup script done."
echo
echo "NEXT STEPS:"
echo "  1) Upload code to $APP_DIR (rsync or scp or git clone)"
echo "  2) cd $APP_DIR && npm ci --omit=dev"
echo "  3) Copy .env (with NODE_ENV=production and SESSION_SECRET set)"
echo "  4) Copy deploy/nginx.conf to /etc/nginx/sites-available/ozawatraders and enable"
echo "  5) sudo certbot --nginx -d $DOMAIN -d $WWW_DOMAIN --non-interactive --agree-tos -m $EMAIL"
echo "  6) pm2 start ecosystem.config.js && pm2 save && pm2 startup"
