package com.odyhibit.qruaware;

import android.Manifest;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.Point;
import android.graphics.drawable.Drawable;
import android.media.Image;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.ZoomState;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;

import java.nio.ByteBuffer;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// Live QR detection via CameraX + ML Kit's on-device barcode scanner.
//
// ML Kit is fast but — unlike iOS Vision's CIQRCodeDescriptor — exposes only the
// decoded text and corner points, not the QR's raw codewords/version/ECC level
// that the app's stego analysis needs. So this plugin only does the *live*
// detection natively (driving the highlight box at native speed, which is what
// fixes the sluggish per-frame JS/ZXing decode on low-end devices); once the
// scan is confirmed, JS pulls one still frame via captureAnalysisFrame() and
// runs it through the existing ZXing/QRParser pipeline for full codeword-level
// analysis. See scanner.js's _enrichNativeResultBeforeConfirm().
//
// Drives ML Kit's BarcodeScanner directly via InputImage/Task (matching
// Google's own current CameraX-MLKit sample) rather than the camera-mlkit-vision
// MlKitAnalyzer helper — that helper's COORDINATE_SYSTEM_VIEW_REFERENCED mode is
// documented as requiring CameraController, which isn't compatible with the
// manual ProcessCameraProvider binding used here, so it never produced a valid
// analysis result when tried. Coordinate mapping is instead done by hand below,
// mirroring the "object-fit: cover" math scanner.js's _getDisplayTransform() and
// the iOS plugin's previewPoint() already use for the same purpose.
@CapacitorPlugin(
    name = "NativeBarcodeDetector",
    permissions = { @Permission(strings = { Manifest.permission.CAMERA }, alias = "camera") }
)
public class NativeBarcodeDetectorPlugin extends Plugin {

    private static final String TAG = "NativeBarcodeDetector";

    // How long after the last ML Kit hit we keep reporting misses to JS — long
    // enough to clear a stale highlight (JS's own grace window is 500ms), short
    // enough that an idle camera doesn't spam the bridge. Mirrors the iOS plugin.
    private static final long MISS_REPORT_WINDOW_MS = 2000;

    private ProcessCameraProvider cameraProvider;
    private Camera camera;
    private PreviewView previewView;
    private ImageCapture imageCapture;
    private BarcodeScanner barcodeScanner;
    private ExecutorService analysisExecutor;
    private Drawable originalWebViewBackground;
    private volatile long lastHitAt = 0;
    private double previewOriginXCss = 0;
    private double previewOriginYCss = 0;
    private double previewWidthCss = 0;
    private double previewHeightCss = 0;
    private boolean starting = false;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermsCallback");
            return;
        }
        startCameraInternal(call);
    }

    @PermissionCallback
    private void cameraPermsCallback(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED) {
            startCameraInternal(call);
        } else {
            call.reject("Camera permission denied");
        }
    }

    private void startCameraInternal(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity available");
            return;
        }
        if (starting) {
            call.reject("Native scanner is already starting");
            return;
        }
        starting = true;

        double[] rect = resolvePreviewRectCss(call);
        previewOriginXCss = rect[0];
        previewOriginYCss = rect[1];
        previewWidthCss = rect[2];
        previewHeightCss = rect[3];

        activity.runOnUiThread(() -> {
            try {
                ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(activity);
                future.addListener(() -> {
                    try {
                        cameraProvider = future.get();
                        bindUseCases(activity, call);
                    } catch (Exception e) {
                        starting = false;
                        Log.e(TAG, "ProcessCameraProvider unavailable", e);
                        call.reject("Could not start native camera", e);
                    }
                }, ContextCompat.getMainExecutor(activity));
            } catch (Exception e) {
                starting = false;
                Log.e(TAG, "Could not request ProcessCameraProvider", e);
                call.reject("Could not start native camera", e);
            }
        });
    }

    // Reads the CSS-pixel rect JS wants the preview positioned at (matching
    // #view-scanner's on-screen bounds), falling back to the full WebView size
    // at (0,0) if the caller didn't supply one.
    private double[] resolvePreviewRectCss(PluginCall call) {
        JSObject rect = call.getObject("previewRect");
        double x = 0, y = 0, w = 0, h = 0;
        if (rect != null) {
            x = rect.optDouble("x", 0);
            y = rect.optDouble("y", 0);
            w = rect.optDouble("width", 0);
            h = rect.optDouble("height", 0);
        }
        if (w <= 0 || h <= 0) {
            View webView = bridge.getWebView();
            float d = density();
            w = webView.getWidth() / d;
            h = webView.getHeight() / d;
            x = 0;
            y = 0;
        }
        return new double[] { x, y, w, h };
    }

    private float density() {
        return getActivity().getResources().getDisplayMetrics().density;
    }

    private void bindUseCases(Activity activity, PluginCall call) {
        try {
            float d = density();

            previewView = new PreviewView(activity);
            previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
            previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
            ViewGroup.LayoutParams lp = new ViewGroup.LayoutParams(
                Math.round((float) previewWidthCss * d), Math.round((float) previewHeightCss * d)
            );
            previewView.setLayoutParams(lp);
            previewView.setX((float) previewOriginXCss * d);
            previewView.setY((float) previewOriginYCss * d);

            WebView webView = (WebView) bridge.getWebView();
            originalWebViewBackground = webView.getBackground();
            webView.setBackgroundColor(Color.TRANSPARENT);
            ViewGroup parent = (ViewGroup) webView.getParent();
            parent.addView(previewView, 0);

            Preview preview = new Preview.Builder().build();
            preview.setSurfaceProvider(previewView.getSurfaceProvider());

            BarcodeScannerOptions options = new BarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .build();
            barcodeScanner = BarcodeScanning.getClient(options);

            analysisExecutor = Executors.newSingleThreadExecutor();
            ImageAnalysis imageAnalysis = new ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build();
            imageAnalysis.setAnalyzer(analysisExecutor, this::analyzeFrame);

            // MAXIMIZE_QUALITY was tried here to help marginal codes (low-contrast
            // engraved coins, etc.) survive our own ZXing-based confirm-time
            // decode, but in practice it didn't fix that case and made every
            // native-Android confirm noticeably slower (extra native processing,
            // larger JPEG to encode/bridge/decode) — a bad trade on a low-end
            // device. Reverted to MINIMIZE_LATENCY. The marginal-code gap likely
            // needs a different fix (e.g. cropping to the known QR region before
            // decode) rather than raw capture quality — left as a known
            // limitation for now.
            imageCapture = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .build();

            cameraProvider.unbindAll();
            camera = cameraProvider.bindToLifecycle(
                (LifecycleOwner) activity, CameraSelector.DEFAULT_BACK_CAMERA,
                preview, imageAnalysis, imageCapture
            );

            starting = false;
            JSObject ret = new JSObject();
            ret.put("hasTorch", camera.getCameraInfo().hasFlashUnit());
            ZoomState zoomState = camera.getCameraInfo().getZoomState().getValue();
            ret.put("minZoom", zoomState != null ? zoomState.getMinZoomRatio() : 1.0);
            ret.put("maxZoom", zoomState != null ? zoomState.getMaxZoomRatio() : 1.0);
            Log.d(TAG, "Camera bound. hasTorch=" + camera.getCameraInfo().hasFlashUnit());
            call.resolve(ret);
        } catch (Exception e) {
            starting = false;
            Log.e(TAG, "Use case binding failed", e);
            call.reject("Could not start native camera", e);
        }
    }

    // Runs on analysisExecutor (background thread). Feeds ML Kit directly via
    // InputImage/Task — see the class-level comment for why this replaced the
    // camera-mlkit-vision MlKitAnalyzer helper.
    private void analyzeFrame(@NonNull ImageProxy imageProxy) {
        Image mediaImage = imageProxy.getImage();
        if (mediaImage == null) {
            imageProxy.close();
            return;
        }

        int rotation = imageProxy.getImageInfo().getRotationDegrees();
        // ML Kit reports corners already rotated into this upright orientation —
        // same content-dimension swap the iOS plugin's isRawLandscape logic does.
        boolean swapped = rotation == 90 || rotation == 270;
        int contentWidth = swapped ? imageProxy.getHeight() : imageProxy.getWidth();
        int contentHeight = swapped ? imageProxy.getWidth() : imageProxy.getHeight();

        InputImage inputImage = InputImage.fromMediaImage(mediaImage, rotation);
        barcodeScanner.process(inputImage)
            .addOnSuccessListener(ContextCompat.getMainExecutor(getActivity()),
                barcodes -> handleBarcodes(barcodes, contentWidth, contentHeight))
            .addOnFailureListener(ContextCompat.getMainExecutor(getActivity()),
                e -> Log.w(TAG, "Barcode scan failed", e))
            .addOnCompleteListener(task -> imageProxy.close());
    }

    private void handleBarcodes(List<Barcode> barcodes, int contentWidth, int contentHeight) {
        Barcode qr = null;
        for (Barcode candidate : barcodes) {
            if (candidate.getFormat() == Barcode.FORMAT_QR_CODE && candidate.getRawValue() != null) {
                qr = candidate;
                break;
            }
        }

        if (qr == null) {
            if (System.currentTimeMillis() - lastHitAt < MISS_REPORT_WINDOW_MS) {
                JSObject miss = new JSObject();
                miss.put("found", false);
                notifyListeners("barcodeDetected", miss);
            }
            return;
        }

        lastHitAt = System.currentTimeMillis();
        float d = density();

        JSObject data = new JSObject();
        data.put("found", true);
        data.put("text", qr.getRawValue());

        Point[] corners = qr.getCornerPoints();
        if (corners != null && corners.length == 4 && previewWidthCss > 0 && previewHeightCss > 0) {
            float previewWidthPx = (float) previewWidthCss * d;
            float previewHeightPx = (float) previewHeightCss * d;
            CoverTransform t = coverTransform(contentWidth, contentHeight, previewWidthPx, previewHeightPx);

            JSArray cornersArray = new JSArray();
            for (Point p : corners) {
                JSObject c = new JSObject();
                // Analysis-image px -> PreviewView-local device px (FILL_CENTER /
                // object-fit: cover) -> CSS px in window space, matching the
                // contract _drawViewportCornersHighlight expects (it subtracts
                // the overlay canvas's getBoundingClientRect(), which equals
                // this preview's own CSS-px origin).
                double localPxX = p.x * t.scale + t.offsetX;
                double localPxY = p.y * t.scale + t.offsetY;
                c.put("x", previewOriginXCss + localPxX / d);
                c.put("y", previewOriginYCss + localPxY / d);
                cornersArray.put(c);
            }
            data.put("corners", cornersArray);
        }

        notifyListeners("barcodeDetected", data);
    }

    private static final class CoverTransform {
        final float scale, offsetX, offsetY;
        CoverTransform(float scale, float offsetX, float offsetY) {
            this.scale = scale;
            this.offsetX = offsetX;
            this.offsetY = offsetY;
        }
    }

    // object-fit: cover — scale to fill dst, crop overflow, centered.
    private CoverTransform coverTransform(int contentWidth, int contentHeight, float dstWidthPx, float dstHeightPx) {
        float contentAspect = (float) contentWidth / contentHeight;
        float dstAspect = dstWidthPx / dstHeightPx;
        float scale;
        float offsetX, offsetY;
        if (contentAspect > dstAspect) {
            scale = dstHeightPx / contentHeight;
            offsetX = (dstWidthPx - contentWidth * scale) / 2f;
            offsetY = 0f;
        } else {
            scale = dstWidthPx / contentWidth;
            offsetX = 0f;
            offsetY = (dstHeightPx - contentHeight * scale) / 2f;
        }
        return new CoverTransform(scale, offsetX, offsetY);
    }

    // Takes one full-resolution still via the bound ImageCapture use case for
    // JS to run through its own ZXing-based decode/module-sampling pipeline —
    // the source of truth for stego analysis, since ML Kit doesn't expose it.
    @PluginMethod
    public void captureAnalysisFrame(PluginCall call) {
        if (imageCapture == null) {
            call.reject("Camera not active");
            return;
        }
        imageCapture.takePicture(ContextCompat.getMainExecutor(getActivity()), new ImageCapture.OnImageCapturedCallback() {
            @Override
            public void onCaptureSuccess(@NonNull ImageProxy image) {
                try {
                    ByteBuffer buffer = image.getPlanes()[0].getBuffer();
                    byte[] bytes = new byte[buffer.remaining()];
                    buffer.get(bytes);
                    String base64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                    JSObject ret = new JSObject();
                    ret.put("image", "data:image/jpeg;base64," + base64);
                    call.resolve(ret);
                } catch (Exception e) {
                    Log.e(TAG, "Frame capture failed", e);
                    call.reject("Frame capture failed", e);
                } finally {
                    image.close();
                }
            }

            @Override
            public void onError(@NonNull ImageCaptureException exception) {
                Log.e(TAG, "Frame capture failed", exception);
                call.reject("Frame capture failed", exception);
            }
        });
    }

    @PluginMethod
    public void setTorch(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on"));
        if (camera == null || !camera.getCameraInfo().hasFlashUnit()) {
            JSObject ret = new JSObject();
            ret.put("on", false);
            call.resolve(ret);
            return;
        }
        camera.getCameraControl().enableTorch(on);
        JSObject ret = new JSObject();
        ret.put("on", on);
        call.resolve(ret);
    }

    @PluginMethod
    public void setZoom(PluginCall call) {
        Double zoom = call.getDouble("zoom");
        if (camera == null || zoom == null) {
            JSObject ret = new JSObject();
            ret.put("zoom", 1.0);
            call.resolve(ret);
            return;
        }
        ZoomState zoomState = camera.getCameraInfo().getZoomState().getValue();
        float min = zoomState != null ? zoomState.getMinZoomRatio() : 1f;
        float max = zoomState != null ? zoomState.getMaxZoomRatio() : 1f;
        float clamped = Math.max(min, Math.min(zoom.floatValue(), max));
        camera.getCameraControl().setZoomRatio(clamped);
        JSObject ret = new JSObject();
        ret.put("zoom", clamped);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopInternal();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopInternal();
    }

    private void stopInternal() {
        Activity activity = getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            if (cameraProvider != null) {
                cameraProvider.unbindAll();
            }
            camera = null;
            imageCapture = null;
            if (barcodeScanner != null) {
                barcodeScanner.close();
                barcodeScanner = null;
            }
            if (analysisExecutor != null) {
                analysisExecutor.shutdown();
                analysisExecutor = null;
            }
            if (previewView != null && previewView.getParent() != null) {
                ((ViewGroup) previewView.getParent()).removeView(previewView);
            }
            previewView = null;
            View webView = bridge.getWebView();
            if (webView != null) {
                webView.setBackground(originalWebViewBackground);
            }
            lastHitAt = 0;
            starting = false;
        });
    }
}
