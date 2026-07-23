'use strict';

// Public client configuration.
// Google API keys are not secret in shipped mobile apps. Restrict this key in
// Google Cloud to the Safe Browsing API and to your app identifiers.
window.QR_STEGO_CONFIG = {
    // iOS-restricted key; also the fallback if a platform-specific key below
    // isn't set.
    googleSafeBrowsingApiKey: '',
    // Android-restricted key. A Google API key supports only one application
    // restriction type, so each platform ships its own key.
    googleSafeBrowsingApiKeyAndroid: '',
    // Web-restricted key (HTTP referrer restriction, e.g. to your GitHub Pages
    // domain). Injected at deploy time by .github/workflows/pages.yml from the
    // GSB_WEB_API_KEY repository secret — see that file for details.
    googleSafeBrowsingApiKeyWeb: '',
    iosBundleId: 'com.odyhibit.qruaware',
    androidPackageName: 'com.odyhibit.qruaware',
    // SHA-1 of the Play app-signing certificate (Play Console -> App integrity),
    // with or without colons. Must match a fingerprint listed in the Android
    // key's restriction.
    androidCertSha1: ''
};
