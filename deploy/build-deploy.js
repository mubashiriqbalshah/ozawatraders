#!/usr/bin/env node
// Generates a self-contained AWS Session Manager paste-script
// that updates the live ozawatraders.org site with the latest local view templates.
// Output: deploy/deploy-<date>.sh

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
    'views/partials/head.ejs',
    'views/partials/footer.ejs',
    'views/index.ejs',
    'views/category.ejs',
    'views/customer.ejs',
    'views/contact.ejs',
];

const ts = new Date().toISOString().slice(0, 10);
const outPath = path.join(__dirname, `deploy-${ts}.sh`);

const writeBlock = (relPath) => {
    const abs = path.join(ROOT, relPath);
    const b64 = fs.readFileSync(abs).toString('base64');
    return `
echo "==> Writing ${relPath}"
mkdir -p "$(dirname "$APP_DIR/${relPath}")"
mkdir -p "$(dirname "$BACKUP_DIR/${relPath}")"
[ -f "$APP_DIR/${relPath}" ] && cp "$APP_DIR/${relPath}" "$BACKUP_DIR/${relPath}"
cat > /tmp/_deploy.b64 <<'B64END'
${b64}
B64END
base64 -d /tmp/_deploy.b64 > "$APP_DIR/${relPath}"
rm /tmp/_deploy.b64
chown www-data:www-data "$APP_DIR/${relPath}" 2>/dev/null || chown ec2-user:ec2-user "$APP_DIR/${relPath}" 2>/dev/null || true
`;
};

const header = `#!/bin/bash
# === Ozawa Traders deploy — italray palette + page-navy + Manrope nav + slider polish ===
# Generated: ${new Date().toISOString()}
# Paste this entire script into AWS Session Manager (logged in as ec2-user or ubuntu).
# Backs up replaced files to a timestamped folder, then restarts PM2.

set -e
APP_DIR=/var/www/ozawatraders
TS=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR=$APP_DIR/.deploy-backup-$TS

echo "==> Backup directory: $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
`;

const footer = `
echo "==> Restarting PM2 (clears EJS view cache)"
pm2 restart ozawatraders 2>/dev/null || pm2 restart all

echo "==> Waiting 3s then verifying live URLs"
sleep 3
for p in / /customer /contact /power-cabinet /micro-feeder /rad; do
    code=$(curl -sk -o /dev/null -w '%{http_code}' "https://ozawatraders.org$p")
    printf "   %-20s status:%s\\n" "$p" "$code"
done

echo "==> Done. Backup at $BACKUP_DIR"
echo "    Rollback: cp -r \\"$BACKUP_DIR\\"/views/* \\"$APP_DIR\\"/views/ && pm2 restart ozawatraders"
`;

const blocks = FILES.map(writeBlock).join('\n');
fs.writeFileSync(outPath, header + blocks + footer);
console.log(`Generated ${outPath} (${fs.statSync(outPath).size} bytes)`);
console.log(`Files included: ${FILES.length}`);
