// Optional: set to point the web app at a different API origin. Empty = same-origin.
window.ADHERE_API_BASE = window.ADHERE_API_BASE || "";

// THE CLINIC'S CLOCK — not the tablet's.
// Every clinical timestamp is written on this zone, regardless of how the device's own clock
// is set. That matters: a tablet with a wrong or foreign time zone would otherwise write wrong
// times into the patient record, silently, and nothing downstream could detect it (we store a
// wall-clock value, not an offset). Pinning it here means the browser, PHP (APP_TZ) and the
// MySQL session all agree on one clock.
// Deploying outside Ethiopia? Change this one line, and APP_TZ in deploy/.env, to match.
window.ADHERE_TZ = window.ADHERE_TZ || "Africa/Addis_Ababa";
