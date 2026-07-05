#!/usr/bin/env bash
# Assemble the Android web bundle fresh from /public (run before a LOCAL APK build).
# CI does this automatically in .github/workflows/build-apk.yml.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; pub="$here/../public"; www="$here/www"
rm -rf "$www"; mkdir -p "$www/model"
cp "$pub/index.html" "$pub/app.js" "$pub/styles.css" "$pub/manifest.webmanifest" "$www/"
cp "$pub/service-worker.js" "$www/" 2>/dev/null || true
cp "$pub/model/"*.js "$pub/model/"*.json "$www/model/"
# API base for the packaged app:
printf 'window.ADHERE_API_BASE = "https://159-89-12-45.sslip.io/";\n' > "$www/config.js"
echo "www assembled from /public. Now run: npx cap sync android && ./gradlew assembleDebug"
