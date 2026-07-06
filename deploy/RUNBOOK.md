# Server deployment runbook

## Option A — Cloud VM + Docker (recommended, full HTTPS)
1. Create a small Linux VM (1–2 GB RAM) on DigitalOcean/Lightsail/Hetzner/Azure.
   Open ports 80 and 443.
2. Install Docker + Docker Compose.
3. Point your subdomain's DNS A-record (e.g. partograph-dev.epichealthsystems.org)
   at the VM's public IP.
4. Copy this project to the VM. Then:
   ```
   cd deploy
   cp .env.example .env          # edit: set SITE_DOMAIN and strong DB passwords
   docker compose --env-file .env -f docker-compose.prod.yml up -d --build
   ```
   Caddy auto-issues a Let's Encrypt certificate for SITE_DOMAIN. App is live at https://SITE_DOMAIN.
5. First-run hardening:
   - Sign in as admin, create real users, then remove any bootstrap defaults.
   - Rotate DB passwords; keep .env out of git.
   - Keep this DEV instance to test/de-identified data only (data residency).

## Option B — Epic cPanel / shared PHP hosting (no Docker)
1. Create a MySQL database + user in cPanel; import every file in docker/init/ in filename order — 01-schema.sql, 02-seed.sql, then 03/04/05 migration files — so supervisor role, user scope, sms_consent, and reminders tables are all created.
2. Upload the contents of public/ to the domain's document root (public_html or a subdomain root).
3. Set DB credentials via environment or edit public/api/config.php.
4. Ensure mod_rewrite + AllowOverride are on (public/api/.htaccess handles routing).
5. cPanel provides HTTPS (AutoSSL). The in-browser AI model needs no server runtime.

## Health check
- https://SITE_DOMAIN            → app loads
- https://SITE_DOMAIN/api/me     → {"user":null}

## Quick start (no domain yet — for testing)
You can get valid HTTPS without buying a domain using sslip.io:
set SITE_DOMAIN to `<VM-PUBLIC-IP-with-dashes>.sslip.io` (e.g. 203-0-113-9.sslip.io).
Then run bootstrap:
```
# on a fresh Ubuntu VM, in the project's deploy/ folder:
./bootstrap_vm.sh 203-0-113-9.sslip.io
```
For production, point a real subdomain's A-record at the VM and use that instead.
