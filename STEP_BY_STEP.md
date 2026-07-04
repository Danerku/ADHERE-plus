# ADHERE+ — deploy it & make the Android app (no-coding guide)

Do Part A first (put it online), then Part B (the Android app), because the app needs
the web address from Part A.

Cost: a small cloud server ~US$6/month. GitHub is free. Time: ~1 hour the first time.
Anywhere you get stuck, send me the screen and I'll walk you through it.

---

# PART A — Put the app on the internet (the server)

You'll rent a small always-on computer in the cloud and run one command on it.

## A1. Put the code on GitHub (needed for the server and the app)
1. Go to github.com and create a free account (if you don't have one).
2. Click the "+" (top right) → "New repository". Name it `adhere-plus`. Set it Private. Create.
3. On the new repo page click "uploading an existing file".
4. Drag in the whole `ADHERE_Plus_Rebuild` folder's contents. Click "Commit changes".
   (If drag-drop of a folder doesn't work, install "GitHub Desktop" — it makes this a
   drag-and-drop app — or tell me and I'll give you the exact steps.)

## A2. Rent a cloud server (a "droplet")
1. Go to digitalocean.com → sign up.
2. Click "Create" → "Droplets".
3. Choose: Region = closest to Ethiopia (e.g. Frankfurt), Image = **Ubuntu** (latest),
   Size = the cheapest "Basic" (~$6/mo, 1 GB).
4. Under "Authentication" pick **Password**, set a strong root password (save it).
5. Click "Create Droplet". After a minute you'll see its **public IP address**
   (four numbers like 203.0.113.9). Copy it.

## A3. Open the server's console and run one command
1. On the droplet page click **"Console"** (opens a black terminal in your browser —
   no extra software needed). Log in as `root` with the password from A2.
2. Copy-paste these lines one at a time (replace the IP in the last line with YOUR IP,
   keeping the dashes):
   ```
   apt-get update -y && apt-get install -y git
   git clone https://github.com/<your-username>/adhere-plus.git
   cd adhere-plus/deploy
   bash bootstrap_vm.sh 203-0-113-9.sslip.io
   ```
   - Replace `<your-username>` with your GitHub username.
   - The last line uses a free web address made from your IP (dashes, then `.sslip.io`).
     It gives you a real "https://" address with a padlock, no domain purchase needed.
   - It will ask for your GitHub username/password (or a token) to download a private repo.
     Easiest: make the repo Public in A1, or tell me and I'll show the token step.
3. Wait ~2–3 minutes. When it finishes, open in your browser:
   `https://203-0-113-9.sslip.io` (your IP). You should see the ADHERE+ login.
   Demo logins: `provider1` / `demo1234`.

## A4. (Optional) Use a real web address later
If Epic has a domain, point a sub-domain (e.g. partograph.epichealthsystems.org) at the
droplet's IP, then re-run the last command with that name instead of the sslip.io one.

**Write down your server address** (e.g. `https://203-0-113-9.sslip.io/`). You need it for Part B.

---

# PART B — Make the Android app (installable on tablets)

No Android Studio needed — GitHub builds the app file (APK) for you.

## B1. Make a repo for just the app
1. On GitHub click "+" → "New repository", name it `adhere-android`, Private, Create.
2. Click "uploading an existing file" and drag in the **contents of the `android-app`
   folder** (so `android-app` is the top level of this repo). Commit.

## B2. Tell the app where your server is
1. In the `adhere-android` repo open the file `www/config.js`.
2. Click the pencil (Edit). Change the address to YOUR server from Part A:
   ```
   window.ADHERE_API_BASE = "https://203-0-113-9.sslip.io/";
   ```
   (Keep the quotes and the trailing slash.) Click "Commit changes".
   (Or tell me your server address and I'll set this for you.)

## B3. Build the app
1. In the repo click the **"Actions"** tab.
2. If asked, click "I understand… enable workflows".
3. Click "Build Android APK" (left) → "Run workflow" → green "Run workflow" button.
4. Wait ~3–5 minutes for the green tick.
5. Click the finished run → scroll to **"Artifacts"** → download `adhere-plus-debug-apk`.
   It downloads a .zip; unzip it to get `app-debug.apk`.

## B4. Install on a tablet
1. Copy `app-debug.apk` to the tablet (USB cable, or email it to yourself, or Google Drive).
2. On the tablet, tap the file. Android will say "install unknown apps" is blocked — tap
   "Settings" → allow it for your file manager → back → Install.
3. Open "ADHERE+ MCH". Log in with a user from the server. It works offline after first login;
   new records sync to the server when there's internet.

---

# What I can do for you
- Set the server address in `config.js` for you (just tell me the address).
- Walk you through any screen live.
- Once it's up, create your real user accounts and remove the demo logins.

# Important reminders
- This is a research/demo build with a **synthetic** AI model — **not for clinical use**
  until it's retrained on real data, security-reviewed, and cleared by ethics/clinicians.
- Keep the demo instance to **non-real / de-identified** data (real patient data must stay
  in an Ethiopian-compliant system).
