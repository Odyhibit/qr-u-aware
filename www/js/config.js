'use strict';

// Public client configuration.
// Google API keys are not secret in shipped mobile apps. Restrict this key in
// Google Cloud to the Safe Browsing API and to your app identifiers.
window.QR_STEGO_CONFIG = {
    // iOS-restricted key; also the fallback for web/dev builds.
    googleSafeBrowsingApiKey: '',
    // Android-restricted key. A Google API key supports only one application
    // restriction type, so each platform ships its own key.
    googleSafeBrowsingApiKeyAndroid: '',
    iosBundleId: 'com.odyhibit.qruaware',
    androidPackageName: 'com.odyhibit.qruaware',
    // SHA-1 of the Play app-signing certificate (Play Console -> App integrity),
    // with or without colons. Must match a fingerprint listed in the Android
    // key's restriction.
    androidCertSha1: ''
};
