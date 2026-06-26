'use strict';

// Public client configuration.
// Google API keys are not secret in shipped mobile apps. Restrict this key in
// Google Cloud to the Safe Browsing API and to your app identifiers.
window.QR_STEGO_CONFIG = {
    googleSafeBrowsingApiKey: '',
    iosBundleId: 'com.odyhibit.qruaware',
    androidPackageName: 'com.odyhibit.qruaware',
    // Release signing certificate SHA-1, with or without colons. Required only
    // if the Google key is restricted to Android apps.
    androidCertSha1: ''
};
