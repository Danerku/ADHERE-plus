#!/usr/bin/env bash
# =============================================================================
# ADHERE+ deploy — hardened.
#
# Install:  sudo cp deploy/deploy-adhere.sh /root/deploy-adhere.sh && sudo chmod +x /root/deploy-adhere.sh
# Run:      /root/deploy-adhere.sh
#
# WHAT THIS ADDS OVER THE OLD SCRIPT (which was otherwise sound):
#
#  1. IT CAN NOW FAIL. The old health checks were `curl -sI ... | head -1`, which PRINTS the status
#     and always exits 0. So when the Hub started returning 404 the deploy still announced
#     "Deployed" — a broken site reported as a success. That is precisely how it went unnoticed.
#     Both sites must now return 200 or the script exits non-zero and says so loudly.
#
#  2. IT VERIFIES THE FILES IT JUST SHIPPED. app.js has twice been truncated by a bad edit and
#     committed. A truncated app.js deploys perfectly happily and then breaks every tablet in every
#     facility, silently. We now assert the served app.js is a plausible size and ends with `boot();`
#     — and ROLL BACK if it isn't.
#
#  3. IT BACKS UP THE DATABASE FIRST. Cheap insurance; the dataset is small.
#
#  4. IT ROLLS BACK on failure — back to the exact commit that was live before.
#
# The Hub is deliberately left alone: its compose file is merged in (so `up -d` can never orphan or
# remove its containers), its Caddy site lives OUTSIDE this repo in /srv/caddy-sites/, and its files
# are served by a host systemd service. Do not "tidy" any of that — each piece is load-bearing.
#
# DO NOT rename the compose project. Docker prefixes named volumes with the project name, so running
# this as project "adhere" instead of "deploy" would look for an empty `adhere_dbdata` and the app
# would come up with ZERO PATIENTS while the real data sat in `deploy_dbdata`.
# =============================================================================
set -euo pipefail

REPO=/root/ADHERE-plus
HUB_COMPOSE=/root/epic-hub/compose.hub.yml
BACKUP_DIR=/root/backups
ADHERE_URL=https://adheretool.epichealthsystems.org/
HUB_URL=https://hub.epichealthsystems.org/

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
info() { printf '\033[36m%s\033[0m\n' "$*"; }

cd "$REPO"
PREV_COMMIT=$(git rev-parse HEAD)
info "Currently deployed: $(git log --oneline -1)"

# ---- 1. back up the database BEFORE anything changes -------------------------------------
mkdir -p "$BACKUP_DIR"
cd "$REPO/deploy"
set -a; . .env; set +a
DC="docker compose --env-file .env -f docker-compose.prod.yml -f $HUB_COMPOSE"

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$BACKUP_DIR/adhere-predeploy-$STAMP.sql.gz"
info "Backing up the database to $BACKUP ..."
$DC exec -T db mysqldump -u root -p"$DB_ROOT_PASS" --single-transaction --routines \
  "$DB_NAME" | gzip > "$BACKUP"
[ -s "$BACKUP" ] || { red "BACKUP FAILED — refusing to deploy."; exit 1; }
grn "  backup ok ($(du -h "$BACKUP" | cut -f1))"
ls -1t "$BACKUP_DIR"/adhere-predeploy-*.sql.gz | tail -n +15 | xargs -r rm --   # keep the last 14

# ---- 2. pull + build ---------------------------------------------------------------------
cd "$REPO"
git pull
NEW_COMMIT=$(git rev-parse HEAD)
info "Deploying: $(git log --oneline -1)"

cd "$REPO/deploy"
$DC up -d --build web
$DC exec -T caddy caddy reload --config /etc/caddy/Caddyfile
sleep 4

# ---- 3. VERIFY. Anything less than green rolls back. --------------------------------------
FAILED=""

check_site() {                      # name url
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$2" || echo 000)
  if [ "$code" = "200" ]; then grn "  $1  $code"; else red "  $1  $code  <-- NOT OK"; FAILED="$FAILED $1"; fi
}

info "Checking both sites ..."
check_site "ADHERE" "$ADHERE_URL"
check_site "HUB   " "$HUB_URL"        # the Hub must survive an ADHERE deploy. If it doesn't, we roll back.

# The file-integrity check that would have caught BOTH app.js truncations.
info "Checking the shipped app.js is intact ..."
APP=$(curl -s --max-time 30 "${ADHERE_URL}app.js?cb=$STAMP" || true)
BYTES=${#APP}
if [ "$BYTES" -lt 300000 ]; then
  red "  app.js is only $BYTES bytes — TRUNCATED. (expected ~366000)"; FAILED="$FAILED app.js-truncated"
elif ! printf '%s' "$APP" | tail -c 20 | grep -q 'boot();'; then
  red "  app.js does not end with boot(); — TRUNCATED or corrupt."; FAILED="$FAILED app.js-corrupt"
else
  grn "  app.js ok ($BYTES bytes, ends with boot();)"
fi

BUILD=$(curl -s --max-time 15 "${ADHERE_URL}index.html?cb=$STAMP" | grep -o 'id="bld">v[0-9.]*' | grep -o 'v[0-9.]*' || true)
info "  build served: ${BUILD:-unknown}"

# ---- 4. roll back if anything is wrong ----------------------------------------------------
if [ -n "$FAILED" ]; then
  red ""
  red "DEPLOY FAILED:$FAILED"
  red "Rolling back to $PREV_COMMIT ..."
  cd "$REPO"
  git reset --hard "$PREV_COMMIT"
  cd "$REPO/deploy"
  $DC up -d --build web
  $DC exec -T caddy caddy reload --config /etc/caddy/Caddyfile
  sleep 4
  red "Rolled back. The database backup is at $BACKUP"
  red "NOTE: a rollback does NOT undo a database migration. If you ran one, restore from the backup."
  exit 1
fi

grn ""
grn "Deployed OK: $(git -C "$REPO" log --oneline -1)"
grn "Backup: $BACKUP"
