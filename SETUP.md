# QR Stego Scanner — Setup

## First time

```bash
cd qr-scanner-app
npm install
npx cap add ios
npx cap add android
```

## After any JS/HTML change

```bash
npx cap sync
```

Then open in Xcode or Android Studio:

```bash
npx cap open ios
npx cap open android
```

## iOS camera permission

Add to `ios/App/App/Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>Camera is used to scan QR codes</string>
```

(Capacitor usually adds this automatically; verify it is present before running.)

## Android camera permission

Add to `android/app/src/main/AndroidManifest.xml` inside `<manifest>`:

```xml
<uses-permission android:name="android.permission.CAMERA" />
<uses-feature android:name="android.hardware.camera" android:required="false" />
```

## Web preview (desktop browser for UI dev)

```bash
npx serve www
# Then open http://localhost:3000
# Camera only works over HTTPS or localhost
```
