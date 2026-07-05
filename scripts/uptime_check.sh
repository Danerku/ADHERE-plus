#!/usr/bin/env bash
# =====================================================================
# ADHERE+ uptime check (host crontab).
#   crontab -e  →  */5 * * * *  /root/ADHERE-plus/scripts/uptime_check.sh >> /var/log/adhere-uptime.log 2>&1
# Logs OK/DOWN each run; wire an alert webhook to get notified on failure.
# =====================================================================
set -uo pipefail
URL="${ADHERE_URL:-https://159-89-12-45.sslip.io/api/me}"
CODE="$(curl -m 15 -s -o /dev/null -w '%{http_code}' "$URL" || echo 000)"
TS="$(date -Is)"

if [ "$CODE" = "200" ]; then
  echo "$TS OK ($CODE)"
else
  echo "$TS DOWN ($CODE) $URL"
  # OPTIONAL alert — uncomment and set ALERT_WEBHOOK (Slack/Telegram/email relay):
  # curl -s -X POST "${ALERT_WEBHOOK:-}" -d "text=ADHERE+ DOWN ($CODE) at $TS" >/dev/null || true
fi
