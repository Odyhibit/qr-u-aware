// Copy this file to secrets.js and fill in your keys.
// secrets.js is gitignored — it is bundled into the app by Xcode/Capacitor
// but never committed to source control.

if (window.QR_STEGO_CONFIG) {
    window.QR_STEGO_CONFIG.googleSafeBrowsingApiKey = '';        // iOS-restricted key
    window.QR_STEGO_CONFIG.googleSafeBrowsingApiKeyAndroid = ''; // Android-restricted key
    window.QR_STEGO_CONFIG.androidCertSha1 = '';                 // Play app-signing SHA-1
    // Web key is normally injected at deploy time from a GitHub Actions
    // secret (see .github/workflows/pages.yml) rather than set here — this
    // field only matters if you're testing the web build locally.
    window.QR_STEGO_CONFIG.googleSafeBrowsingApiKeyWeb = '';
}
