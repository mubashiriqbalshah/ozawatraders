# Ozawa Traders — Production Deployment Guide

Target: replace the existing site on AWS EC2 instance `i-07d3bd3bc8116189c` (IP `18.222.188.109`, region `us-east-2`) with the new Express app, keeping the same instance and IP. Domain `ozawatraders.org` already resolves to this IP, so **no DNS change is required** — registrar (OnlyDomains.com) untouched.

---

## Phase 1 — Backup the existing site (DO THIS FIRST)

Create an AMI snapshot so the old site can be restored if anything goes wrong.

1. AWS Console → EC2 → **Instances** → select `i-07d3bd3bc8116189c`
2. **Actions → Image and templates → Create image**
3. Name: `ozawatraders-old-website-backup-YYYY-MM-DD`
4. Description: `Backup before new site deployment`
5. Click **Create image** and wait until status is `available` in the AMIs panel (~5–10 min)
6. (Optional) AWS Console → EBS → **Snapshots** — verify a snapshot exists too

Restore (if ever needed): EC2 → AMIs → select the backup → **Launch instance from AMI**.

---

## Phase 2 — Prepare new code for deployment

On your local machine (where this repo lives):

1. Generate a strong session secret:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```
2. Create `.env` (copy from `.env.example`) with that secret and `NODE_ENV=production`.
3. Build a deployment archive (excludes node_modules, uploads, dev junk):
   ```powershell
   tar --exclude=node_modules --exclude=img/uploads --exclude=.git -czf ozawatraders-app.tar.gz .
   ```
   Or zip the project (without `node_modules/` and `img/uploads/`).

---

## Phase 3 — Server setup (one-time)

SSH into the EC2 instance:

```bash
ssh -i /path/to/your-key.pem ubuntu@18.222.188.109
# OR if Amazon Linux:
ssh -i /path/to/your-key.pem ec2-user@18.222.188.109
```

If existing site uses Apache/HTTP only on port 80, you'll be replacing that.

1. Upload `setup-server.sh` (from `deploy/` folder) and run:
   ```bash
   sudo bash setup-server.sh
   ```
   Installs: Node.js 20, Nginx, PM2, Certbot, ufw, builds tools.

2. Upload the deployment archive:
   ```bash
   # From local
   scp -i your-key.pem ozawatraders-app.tar.gz ubuntu@18.222.188.109:/tmp/
   # On server
   sudo mkdir -p /var/www/ozawatraders
   sudo tar -xzf /tmp/ozawatraders-app.tar.gz -C /var/www/ozawatraders
   sudo chown -R www-data:www-data /var/www/ozawatraders
   ```

3. Install npm dependencies on server:
   ```bash
   cd /var/www/ozawatraders
   sudo -u www-data npm ci --omit=dev
   ```

4. Upload `.env` (with production session secret) to `/var/www/ozawatraders/.env`:
   ```bash
   scp -i your-key.pem .env ubuntu@18.222.188.109:/tmp/.env
   sudo mv /tmp/.env /var/www/ozawatraders/.env
   sudo chown www-data:www-data /var/www/ozawatraders/.env
   sudo chmod 600 /var/www/ozawatraders/.env
   ```

5. Install Nginx config:
   ```bash
   sudo cp /var/www/ozawatraders/deploy/nginx.conf /etc/nginx/sites-available/ozawatraders
   sudo ln -sf /etc/nginx/sites-available/ozawatraders /etc/nginx/sites-enabled/
   sudo rm -f /etc/nginx/sites-enabled/default
   sudo nginx -t
   ```
   If `nginx -t` fails because SSL certs don't exist yet, comment out the HTTPS server block temporarily (or use Certbot's --nginx flag in the next step which will manage it).

6. Issue Let's Encrypt SSL certificate:
   ```bash
   sudo certbot --nginx -d ozawatraders.org -d www.ozawatraders.org \
       --non-interactive --agree-tos -m info@ozawatraders.org
   ```

7. Start the app under PM2:
   ```bash
   cd /var/www/ozawatraders
   sudo -u www-data pm2 start ecosystem.config.js
   sudo -u www-data pm2 save
   sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u www-data --hp /var/www
   sudo systemctl restart nginx
   ```

---

## Phase 4 — Verify

- https://ozawatraders.org → new site loads, banner rotates, products visible
- https://ozawatraders.org/admin/login → login with `admin` / `admin123`
- **Immediately change password** at `/admin/settings`
- Test image upload (upload a customer logo and verify it persists)
- Mobile and desktop visual check

---

## Phase 5 — Lock down (recommended)

1. **Attach Elastic IP** so server IP doesn't change on reboot:
   AWS Console → EC2 → Elastic IPs → Allocate → Associate to `i-07d3bd3bc8116189c`.

2. **Stronger admin password** — done at /admin/settings.

3. **Backups schedule** — configure AWS Backup or weekly AMI rotation.

4. **(Optional) Persistent uploads to S3** — currently uploads go to local `img/uploads/`. If instance dies, uploads lost. Future improvement: move uploads to S3 + CloudFront.

---

## Rollback (if anything breaks)

The original AMI from Phase 1 can launch a fresh instance. Then:
- Detach Elastic IP from current instance, attach to restored instance, OR
- DNS at OnlyDomains: change A record to restored instance's IP (TTL-dependent propagation).

---

## Files in this repo for deployment

| File | Purpose |
|---|---|
| `.env.example` | Template for production env vars |
| `.gitignore` | Excludes secrets, node_modules, uploads from any git push |
| `ecosystem.config.js` | PM2 config — runs server.js with logs and auto-restart |
| `deploy/nginx.conf` | Nginx reverse proxy + SSL + caching template |
| `deploy/setup-server.sh` | Ubuntu one-shot installer (Node, Nginx, PM2, Certbot) |
