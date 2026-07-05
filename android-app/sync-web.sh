#!/usr/bin/env bash
# Copy the web app into the Android bundle, EXCLUDING the PHP backend (api/).
set -e
cd "$(dirname "$0")"
if [ ! -d ../public ]; then echo "ERROR: ../public not found. Run from the repo working tree; a real web bundle cannot be assembled without it. (CI assembles www/ itself.)" >&2; exit 1; fi
rsync -a --delete --exclude 'api' ../public/ www/ 2>/dev/null || { rm -rf www_tmp; mkdir www_tmp; cp -r ../public/* www_tmp/; rm -rf www_tmp/api; rm -rf www; mv www_tmp www; }
cat > www/config.js <<CFG
window.ADHERE_API_BASE = "https://159-89-12-45.sslip.io/";
CFG
grep -q 'src="./config.js"' www/index.html || sed -i 's#<script src="./app.js"></script>#<script src="./config.js"></script>\n<script src="./app.js"></script>#' www/index.html
echo "www synced (api excluded). Now: npx cap sync android"
