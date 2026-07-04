# Build the ADHERE+ Android app (Capacitor)

The app wraps the web UI + on-device AI model and **bundles them into the APK**, so it
runs fully offline on the tablet. It talks to your deployed server only for data sync.

## One-time setup on your machine
Install: Node.js 18+, Android Studio (with Android SDK + a JDK).

## Point the app at your server
Edit `www/config.js`:
```
window.ADHERE_API_BASE = "https://<your-server-domain>/";   // must end with a slash
```

## Build
```
cd android-app
npm install
npx cap sync android          # copies www/ (incl. model) into the Android project
npx cap open android          # opens Android Studio
```
In Android Studio: Build → Build APK (or Run on a connected tablet).
- Debug APK → sideload to facility tablets (Settings → allow install from this source).
- For Play Store: Build → Generate Signed Bundle (AAB), create a signing key, upload.

## Offline behaviour
- UI + partograph + AI risk score run locally (no connectivity needed).
- New records queue on the device and sync to the server when back online.

## Update the app after web changes
```
bash sync-web.sh        # copies public/ into www/ and EXCLUDES the PHP api/
npx cap sync android
```
then rebuild in Android Studio.

## Alternative: TWA (thinner, needs the server reachable)
If you prefer a Play-Store PWA wrapper instead of a bundled app, use Bubblewrap
against the deployed https URL. Capacitor (above) is recommended for offline-first tablets.

## Sideload path (chosen) — two ways to get the APK

### A) No local setup — build in the cloud (easiest)
Push `android-app/` to a GitHub repo. The included workflow
(`.github/workflows/build-apk.yml`) builds a debug APK on every push and under
Actions → "Build Android APK" → Run. Download the `adhere-plus-debug-apk` artifact
and install it on the tablets (enable "install unknown apps" for your file manager).

### B) Local (Android Studio)
`npm install → chmod +x android/gradlew → npx cap sync android → npx cap open android → Build → Build APK`. (The chmod is only needed once, if the wrapper lost its executable bit during download/unzip.)

A debug APK is fine for a pilot sideload. For a signed release APK later, create a
keystore and use Build → Generate Signed Bundle/APK.
