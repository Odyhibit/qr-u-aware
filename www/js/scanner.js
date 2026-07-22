// Camera + ZXing QR scan loop with highlight overlay and manual confirm UX.
//
// Successful decodes update the highlighted QR and a frozen frame snapshot.
// The user chooses when to confirm, so they can aim at the intended QR before
// the decoded data is processed.

let _stream = null;
let _animFrame = null;
let _onConfirm = null;
let _qrReader = null;
let _decodeHints = null;
let _capturingSampler = null;
let _overlayEl = null;
let _canvasEl = null;
let _videoTrack = null;
let _cameraCaps = null;
let _torchBtn = null;
let _torchOn = false;
let _pinchTarget = null;
let _pinchStartDistance = 0;
let _pinchStartZoom = 1;
let _zoomValue = 1;
let _zoomApplying = false;
let _queuedZoom = null;
let _pendingResult = null;
let _lastDetectionAt = 0;
let _autoConfirmTimer = null;
let _stableText = null;
let _stableDecodeCount = 0;
let _usingNativeDetection = false;
let _nativeDetecting = false;
let _nativeListener = null;
let _smoothedCorners = null;
let _nativeCaps = null;

// How long the highlight stays visible before auto-confirming.
const AUTO_CONFIRM_DELAY_MS = 450;
// Android's native path waits on a follow-up capture+decode after this timer
// fires (see _enrichNativeResultBeforeConfirm) — the highlight stays visible
// through that wait too (confirmScan()/stopScanner() doesn't run until after
// it resolves), so the upfront dwell can be much shorter there than on
// iOS/web, where confirming ends the highlight immediately.
const AUTO_CONFIRM_DELAY_NATIVE_ENRICH_MS = 150;
const DETECTION_GRACE_MS = 500;
const AUTO_CONFIRM_FRESHNESS_MS = 650;
const STABLE_DECODE_FRAMES = 2;
// Fraction of the distance to the new corner positions covered each frame — lower is
// smoother/laggier, higher is snappier/more jittery.
const CORNER_SMOOTHING = 0.55;

// Intercepts ZXing's internal GridSampler to capture the perspective-corrected
// BitMatrix (the clean boolean module grid) before it's consumed by the decoder.
// Also saves the raw PerspectiveTransform so the overlay can compute true QR corners.
class CapturingGridSampler extends ZXing.DefaultGridSampler {
    constructor() {
        super();
        this.lastBits = null;
        this.lastModules = null;
        this.lastTransform = null;
        this.lastDimX = 0;
        this.lastDimY = 0;
    }
    sampleGridWithTransform(image, dimensionX, dimensionY, transform) {
        const bits = super.sampleGridWithTransform(image, dimensionX, dimensionY, transform);
        this.lastBits = bits;
        this.lastModules = _snapshotBitMatrix(bits);
        this.lastTransform = transform;
        this.lastDimX = dimensionX;
        this.lastDimY = dimensionY;
        return bits;
    }
}

async function startScanner(videoEl, canvasEl, overlayEl, onConfirm) {
    _onConfirm = onConfirm;
    _overlayEl = overlayEl;
    _canvasEl = canvasEl;
    _pendingResult = null;
    _lastDetectionAt = 0;
    _autoConfirmTimer = null;
    _stableText = null;
    _stableDecodeCount = 0;
    _usingNativeDetection = false;
    _nativeDetecting = false;
    _smoothedCorners = null;
    _nativeCaps = null;
    videoEl.classList.remove('video-ready');

    // Always set up, regardless of path: a confirmed Android native detection
    // needs these to run one ZXing decode pass on a captured still — see
    // _enrichNativeResultBeforeConfirm(). Harmless/unused on iOS.
    _capturingSampler = new CapturingGridSampler();
    ZXing.GridSamplerInstance.setGridSampler(_capturingSampler);
    _qrReader = new ZXing.QRCodeReader();
    _decodeHints = new Map([
        [ZXing.DecodeHintType.TRY_HARDER, true],
        [ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]],
    ]);

    _usingNativeDetection = _shouldUseNativeDetection();
    if (_usingNativeDetection) {
        try {
            await _startNativeLiveScanner(videoEl, canvasEl);
            return;
        } catch (_) {
            // Native camera failed to start (AV session error, etc.) — fall
            // back to the web scanner rather than leaving a dead camera view.
            // Permission errors resurface below via getUserMedia.
            _usingNativeDetection = false;
        }
    }

    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera not available. iOS Simulator has no camera — test on a real device.');
    }

    _stream = await navigator.mediaDevices.getUserMedia({
        video: {
            facingMode: { ideal: 'environment' },
            width:  { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 }
        }
    });
    _videoTrack = _stream.getVideoTracks()[0] || null;
    _cameraCaps = _getCameraCapabilities(_videoTrack);
    _zoomValue = _getCurrentZoom();
    videoEl.srcObject = _stream;
    videoEl.setAttribute('playsinline', true);
    await _waitForVideoMetadata(videoEl);
    await videoEl.play();
    await _waitForStablePaint();
    videoEl.classList.add('video-ready');

    _setupTorchButton();
    _setupPinchZoom(videoEl);
    _tick(videoEl, canvasEl);
}

// iOS and Android both scan with the native detector (Vision / CameraX+ML Kit);
// browsers and other contexts fall back to the ZXing web path below. Android's
// detector only supplies live text+corners (no codeword data — see
// _enrichNativeResultBeforeConfirm), unlike iOS's Vision which supplies both.
function _shouldUseNativeDetection() {
    const platform = window.Capacitor?.getPlatform?.();
    if (platform !== 'ios' && platform !== 'android') return false;
    const plugin = _nativeDetectorPlugin();
    return Boolean(plugin && typeof plugin.start === 'function');
}

function _nativeDetectorPlugin() {
    return window.Capacitor?.Plugins?.NativeBarcodeDetector || window.NativeBarcodeDetector || null;
}

async function _startNativeLiveScanner(videoEl, canvasEl) {
    const plugin = _nativeDetectorPlugin();
    if (!plugin || typeof plugin.start !== 'function') {
        throw new Error('Native scanner is not available on this platform.');
    }

    document.documentElement.classList.add('native-camera-active');
    document.body.classList.add('native-camera-active');
    document.getElementById('view-scanner')?.classList.add('native-camera-active');
    videoEl.classList.add('video-ready');

    _nativeListener = await plugin.addListener('barcodeDetected', result => {
        if (!_usingNativeDetection) return;
        if (!result?.text) {
            _handleDecodeMiss();
            return;
        }

        const rawBytes = Array.isArray(result.rawBytes) && result.rawBytes.length
            ? Uint8Array.from(result.rawBytes)
            : null;
        // Vision's CIQRCodeDescriptor exposes version/mask/ECC level directly, so the
        // raw-data view can still show those (and derive the padding secret from
        // rawBytes) even without a module grid — see QRStego.decode()'s nativeMeta path.
        const nativeMeta = (typeof result.version === 'number' && result.eccLevel)
            ? { version: result.version, mask: result.mask, eccLevel: result.eccLevel }
            : null;
        _acceptDecodedResult(videoEl, canvasEl, {
            text: result.text,
            bitMatrix: null,
            rawModules: null,
            rawBytes,
            nativeMeta,
            moduleImage: result.moduleImage || null,
            moduleCount: result.moduleCount || null,
            snap: null,
            detectedAt: performance.now(),
            viewportCorners: result.corners || null
        });
    });

    try {
        _nativeCaps = await plugin.start({ previewRect: _nativePreviewRect() });
        _zoomValue = _getCurrentZoom();
        _setupTorchButton();
        _setupPinchZoom(videoEl);
    } catch (err) {
        if (_nativeListener) {
            _nativeListener.remove();
            _nativeListener = null;
        }
        document.documentElement.classList.remove('native-camera-active');
        document.body.classList.remove('native-camera-active');
        document.getElementById('view-scanner')?.classList.remove('native-camera-active');
        videoEl.classList.remove('video-ready');
        _usingNativeDetection = false;
        throw err;
    }
}

function _nativePreviewRect() {
    const rect = (document.getElementById('view-scanner') || _overlayEl)?.getBoundingClientRect();
    if (!rect) return null;
    return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
    };
}

function _waitForVideoMetadata(videoEl) {
    if (videoEl.readyState >= videoEl.HAVE_METADATA && videoEl.videoWidth && videoEl.videoHeight) {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        const done = () => {
            videoEl.removeEventListener('loadedmetadata', done);
            resolve();
        };
        videoEl.addEventListener('loadedmetadata', done, { once: true });
    });
}

function _waitForStablePaint() {
    return new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
}

function _getCameraCapabilities(track) {
    if (!track || typeof track.getCapabilities !== 'function') return {};
    try {
        return track.getCapabilities() || {};
    } catch (_) {
        return {};
    }
}

function _getCurrentZoom() {
    if (_usingNativeDetection) {
        return _nativeCaps && typeof _nativeCaps.minZoom === 'number' ? _nativeCaps.minZoom : 1;
    }
    const zoomCaps = _cameraCaps?.zoom;
    const settings = typeof _videoTrack?.getSettings === 'function' ? _videoTrack.getSettings() : {};
    if (typeof settings.zoom === 'number') return settings.zoom;
    if (zoomCaps && typeof zoomCaps.min === 'number') return zoomCaps.min;
    return 1;
}

function _setupTorchButton() {
    _torchBtn = document.getElementById('scanner-torch-btn');
    if (!_torchBtn) return;

    _torchOn = false;
    _updateTorchButton();
    _torchBtn.onclick = _toggleTorch;
    _torchBtn.classList.toggle('hidden', !_supportsTorch());
}

function _supportsTorch() {
    if (_usingNativeDetection) return Boolean(_nativeCaps && _nativeCaps.hasTorch);
    return Boolean(_videoTrack && _cameraCaps && _cameraCaps.torch);
}

async function _toggleTorch() {
    if (!_supportsTorch()) return;
    await _setTorch(!_torchOn);
}

async function _setTorch(on) {
    if (!_supportsTorch()) return;
    try {
        if (_usingNativeDetection) {
            const result = await _nativeDetectorPlugin()?.setTorch({ on: Boolean(on) });
            _torchOn = Boolean(result?.on);
        } else {
            await _videoTrack.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
            _torchOn = Boolean(on);
        }
        _updateTorchButton();
    } catch (err) {
        console.warn('Torch control failed:', err);
        _torchOn = false;
        _updateTorchButton();
    }
}

function _updateTorchButton() {
    if (!_torchBtn) return;
    _torchBtn.classList.toggle('is-active', _torchOn);
    _torchBtn.setAttribute('aria-pressed', _torchOn ? 'true' : 'false');
    _torchBtn.setAttribute('aria-label', _torchOn ? 'Turn flashlight off' : 'Turn flashlight on');
}

function _setupPinchZoom(videoEl) {
    _pinchTarget = document.getElementById('view-scanner') || videoEl;
    if (!_pinchTarget || !_supportsZoom()) return;

    _pinchTarget.addEventListener('touchstart', _onTouchStart, { passive: false });
    _pinchTarget.addEventListener('touchmove', _onTouchMove, { passive: false });
    _pinchTarget.addEventListener('touchend', _onTouchEnd, { passive: true });
    _pinchTarget.addEventListener('touchcancel', _onTouchEnd, { passive: true });
}

function _teardownPinchZoom() {
    if (!_pinchTarget) return;
    _pinchTarget.removeEventListener('touchstart', _onTouchStart);
    _pinchTarget.removeEventListener('touchmove', _onTouchMove);
    _pinchTarget.removeEventListener('touchend', _onTouchEnd);
    _pinchTarget.removeEventListener('touchcancel', _onTouchEnd);
    _pinchTarget = null;
    _pinchStartDistance = 0;
}

// Returns { min, max, step } from whichever camera source is active, or null if
// zoom isn't available.
function _zoomRange() {
    if (_usingNativeDetection) {
        if (!_nativeCaps || typeof _nativeCaps.minZoom !== 'number' || typeof _nativeCaps.maxZoom !== 'number') return null;
        return { min: _nativeCaps.minZoom, max: _nativeCaps.maxZoom, step: 0 };
    }
    const zoomCaps = _cameraCaps?.zoom;
    if (!_videoTrack || !zoomCaps || typeof zoomCaps.min !== 'number' || typeof zoomCaps.max !== 'number') return null;
    return { min: zoomCaps.min, max: zoomCaps.max, step: zoomCaps.step };
}

function _supportsZoom() {
    const range = _zoomRange();
    return Boolean(range && range.max > range.min);
}

function _onTouchStart(event) {
    if (event.touches.length !== 2 || !_supportsZoom()) return;
    event.preventDefault();
    _pinchStartDistance = _touchDistance(event.touches[0], event.touches[1]);
    _pinchStartZoom = _zoomValue || _getCurrentZoom();
}

function _onTouchMove(event) {
    if (event.touches.length !== 2 || !_pinchStartDistance || !_supportsZoom()) return;
    event.preventDefault();
    const distance = _touchDistance(event.touches[0], event.touches[1]);
    const nextZoom = _pinchStartZoom * (distance / _pinchStartDistance);
    _applyZoom(nextZoom);
}

function _onTouchEnd(event) {
    if (event.touches.length < 2) _pinchStartDistance = 0;
}

function _touchDistance(a, b) {
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function _clampZoom(value) {
    const range = _zoomRange();
    if (!range) return value;
    const step = typeof range.step === 'number' && range.step > 0 ? range.step : 0;
    let next = Math.min(range.max, Math.max(range.min, value));
    if (step) next = Math.round(next / step) * step;
    return Number(next.toFixed(4));
}

async function _applyZoom(value) {
    if (!_supportsZoom()) return;
    const next = _clampZoom(value);
    if (Math.abs(next - _zoomValue) < 0.01) return;

    _queuedZoom = next;
    if (_zoomApplying) return;

    _zoomApplying = true;
    while (_queuedZoom !== null && (_usingNativeDetection || _videoTrack)) {
        const zoom = _queuedZoom;
        _queuedZoom = null;
        try {
            if (_usingNativeDetection) {
                const result = await _nativeDetectorPlugin()?.setZoom({ zoom });
                _zoomValue = typeof result?.zoom === 'number' ? result.zoom : zoom;
            } else {
                await _videoTrack.applyConstraints({ advanced: [{ zoom }] });
                _zoomValue = zoom;
            }
        } catch (err) {
            console.warn('Camera zoom failed:', err);
            _queuedZoom = null;
        }
    }
    _zoomApplying = false;
}

// Tries three binarization strategies on the same luminance source.
// Each strategy only runs if the previous one threw (i.e. found nothing).
// The CapturingGridSampler records whichever strategy succeeds.
function _decodeMultiStrategy(lum) {
    // 1. Hybrid adaptive threshold — best for uneven or gradient lighting.
    try {
        return _qrReader.decode(
            new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum)), _decodeHints
        );
    } catch (_) {}

    // 2. Global histogram threshold — better for flat, evenly lit codes
    //    and codes where local contrast fools the adaptive algorithm.
    try {
        return _qrReader.decode(
            new ZXing.BinaryBitmap(new ZXing.GlobalHistogramBinarizer(lum)), _decodeHints
        );
    } catch (_) {}

    // 3. Inverted + hybrid — handles light-module-on-dark-background codes.
    try {
        return _qrReader.decode(
            new ZXing.BinaryBitmap(
                new ZXing.HybridBinarizer(new ZXing.InvertedLuminanceSource(lum))
            ),
            _decodeHints
        );
    } catch (_) {}

    return null;
}

function _tick(videoEl, canvasEl) {
    if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        const ctx = canvasEl.getContext('2d', { willReadFrequently: true });

        if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
            canvasEl.width = videoEl.videoWidth;
            canvasEl.height = videoEl.videoHeight;
        }
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

        try {
            const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvasEl);
            const result = _decodeMultiStrategy(lum);
            if (!result) throw new Error('no decode');

            // Clone the frame immediately — before any camera movement.
            const clone = document.createElement('canvas');
            clone.width = canvasEl.width;
            clone.height = canvasEl.height;
            clone.getContext('2d').drawImage(canvasEl, 0, 0);

            _acceptDecodedResult(videoEl, canvasEl, {
                text: result.getText(),
                bitMatrix: _capturingSampler.lastBits,
                rawModules: _capturingSampler.lastModules,
                rawBytes: typeof result.getRawBytes === 'function' ? result.getRawBytes() : null,
                snap: { canvas: clone, transform: _capturingSampler.lastTransform },
                detectedAt: performance.now(),
                points: result.getResultPoints ? result.getResultPoints() : []
            });
        } catch (_) {
            _handleDecodeMiss();
        }
    }
    _animFrame = requestAnimationFrame(() => _tick(videoEl, canvasEl));
}

function _tickNative(videoEl, canvasEl) {
    if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA) {
        const ctx = canvasEl.getContext('2d', { willReadFrequently: true });

        if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
            canvasEl.width = videoEl.videoWidth;
            canvasEl.height = videoEl.videoHeight;
        }
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);

        const plugin = _nativeDetectorPlugin();
        if (!_nativeDetecting && plugin) {
            const clone = document.createElement('canvas');
            clone.width = canvasEl.width;
            clone.height = canvasEl.height;
            clone.getContext('2d').drawImage(canvasEl, 0, 0);

            _nativeDetecting = true;
            plugin.detect({ image: canvasEl.toDataURL('image/jpeg', 0.65) })
                .then(result => {
                    if (!_stream || !_usingNativeDetection) return;
                    if (!result?.found || !result.text) {
                        _handleDecodeMiss();
                        return;
                    }

                    const rawBytes = Array.isArray(result.rawBytes) && result.rawBytes.length
                        ? Uint8Array.from(result.rawBytes)
                        : null;
                    _acceptDecodedResult(videoEl, canvasEl, {
                        text: result.text,
                        bitMatrix: null,
                        rawModules: null,
                        rawBytes,
                        snap: { canvas: clone, transform: null },
                        detectedAt: performance.now(),
                        corners: result.corners || null
                    });
                })
                .catch(() => {
                    if (_stream && _usingNativeDetection) _handleDecodeMiss();
                })
                .finally(() => {
                    _nativeDetecting = false;
                });
        }
    }
    _animFrame = requestAnimationFrame(() => _tickNative(videoEl, canvasEl));
}

function _acceptDecodedResult(videoEl, canvasEl, result) {
    if (result.text === _stableText) {
        _stableDecodeCount++;
    } else {
        _stableText = result.text;
        _stableDecodeCount = 1;
        _cancelAutoConfirm();
        // A different code may be in a completely different spot — snap to it
        // instead of sliding the outline over from the old code's position.
        _smoothedCorners = null;
    }

    _pendingResult = {
        text: result.text,
        bitMatrix: result.bitMatrix || null,
        rawModules: result.rawModules || null,
        rawBytes: result.rawBytes || null,
        nativeMeta: result.nativeMeta || null,
        moduleImage: result.moduleImage || null,
        moduleCount: result.moduleCount || null,
        snap: result.snap || null,
        detectedAt: result.detectedAt || performance.now()
    };

    if (result.viewportCorners) {
        _drawViewportCornersHighlight(result.viewportCorners);
    } else if (result.corners) {
        _drawCornersHighlight(videoEl, canvasEl, result.corners);
    } else {
        _drawHighlight(videoEl, canvasEl, result.points || []);
    }
    _lastDetectionAt = _pendingResult.detectedAt;

    // Start the auto-confirm countdown once per detection window. The highlight
    // stays visible for this dwell so the user can see which code was scanned
    // before the result screen appears — except on Android's native path when
    // it's about to need _enrichNativeResultBeforeConfirm's capture+decode,
    // where the highlight already stays up through that extra wait, so a much
    // shorter dwell here doesn't cost anything visually.
    if (_stableDecodeCount >= STABLE_DECODE_FRAMES && !_autoConfirmTimer) {
        const needsNativeEnrichment = _usingNativeDetection &&
            !_pendingResult.bitMatrix && !_pendingResult.rawModules && !_pendingResult.nativeMeta;
        const delay = needsNativeEnrichment ? AUTO_CONFIRM_DELAY_NATIVE_ENRICH_MS : AUTO_CONFIRM_DELAY_MS;
        _autoConfirmTimer = setTimeout(_fireAutoConfirm, delay);
    }
}

function _handleDecodeMiss() {
    // A marginal/damaged code can read successfully but not on every single frame — only
    // give up on it (and lose the accumulated stability count) once the misses persist
    // past the grace window, rather than resetting on the very first missed frame. A
    // one-off miss between good reads shouldn't restart the confirmation countdown.
    if (performance.now() - _lastDetectionAt > DETECTION_GRACE_MS) {
        _pendingResult = null;
        _stableText = null;
        _stableDecodeCount = 0;
        _cancelAutoConfirm();
        _clearHighlight();
    }
}

function _cancelAutoConfirm() {
    if (!_autoConfirmTimer) return;
    clearTimeout(_autoConfirmTimer);
    _autoConfirmTimer = null;
}

async function _fireAutoConfirm() {
    _autoConfirmTimer = null;
    if (!_pendingResult) return;

    if (
        _stableDecodeCount >= STABLE_DECODE_FRAMES &&
        _pendingResult.text === _stableText &&
        performance.now() - _pendingResult.detectedAt <= AUTO_CONFIRM_FRESHNESS_MS
    ) {
        await _enrichNativeResultBeforeConfirm();
        if (_pendingResult) confirmScan();
        return;
    }

    _pendingResult = null;
}

// Android's native plugin only supplies text + corners live (ML Kit doesn't
// expose codewords the way iOS's Vision does), so right before a scan is
// confirmed, pull one full-resolution still from the plugin and run it
// through the same ZXing decode _tick() uses for the web path, to get real
// bitMatrix/rawModules/rawBytes for stego analysis. No-op for iOS (already
// has nativeMeta) and for the web path (already has bitMatrix from _tick).
async function _enrichNativeResultBeforeConfirm() {
    if (!_pendingResult || !_usingNativeDetection) return;
    if (_pendingResult.bitMatrix || _pendingResult.rawModules || _pendingResult.nativeMeta) return;
    const plugin = _nativeDetectorPlugin();
    if (!plugin || typeof plugin.captureAnalysisFrame !== 'function') return;
    try {
        const { image } = await plugin.captureAnalysisFrame();
        if (!image || !_pendingResult) return;
        const decoded = await _decodeStillImageDataUrl(image);
        if (decoded && _pendingResult) {
            _pendingResult.bitMatrix = decoded.bitMatrix;
            _pendingResult.rawModules = decoded.rawModules;
            _pendingResult.rawBytes = decoded.rawBytes;
        } else {
            // ML Kit found this live, but our own ZXing decode of the confirm-time
            // still failed — happens on marginal codes (low-contrast/engraved)
            // where ML Kit's detector is more tolerant than ours. Result screen
            // still works with text-only content; Raw QR Data just won't show.
            console.warn('Native confirm-time decode found no result for a still that ML Kit detected live.');
        }
    } catch (err) {
        console.warn('Native confirm-time enrichment failed:', err);
    }
}

// Decodes a single still image (data URL) via the same multi-strategy ZXing
// pipeline _tick() uses live, for the confirm-time enrichment above.
function _decodeStillImageDataUrl(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                canvas.getContext('2d').drawImage(img, 0, 0);
                const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
                const result = _decodeMultiStrategy(lum);
                if (!result) { resolve(null); return; }
                resolve({
                    bitMatrix: _capturingSampler.lastBits,
                    rawModules: _capturingSampler.lastModules,
                    rawBytes: typeof result.getRawBytes === 'function' ? result.getRawBytes() : null
                });
            } catch (_) {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}

// Returns the affine scale/offset that maps video pixel coords to display pixel coords,
// accounting for object-fit: cover cropping.
function _getDisplayTransform(videoEl, canvasEl) {
    const vW = canvasEl.width, vH = canvasEl.height;
    const dW = videoEl.clientWidth, dH = videoEl.clientHeight;
    const vAR = vW / vH, dAR = dW / dH;
    let sX, sY, oX, oY;
    if (vAR > dAR) {
        sY = dH / vH; sX = sY;
        oX = (dW - vW * sX) / 2; oY = 0;
    } else {
        sX = dW / vW; sY = sX;
        oX = 0; oY = (dH - vH * sY) / 2;
    }
    return { scaleX: sX, scaleY: sY, offsetX: oX, offsetY: oY };
}

// Eases the outline toward each new detection instead of snapping straight to it, so
// per-frame decode jitter doesn't read as the box jumping around. First call (or a call
// after _smoothedCorners was reset) snaps immediately since there's nothing to ease from.
function _smoothCorners(rawCorners) {
    if (!_smoothedCorners || _smoothedCorners.length !== rawCorners.length) {
        _smoothedCorners = rawCorners.map(p => ({ x: p.x, y: p.y }));
        return _smoothedCorners;
    }
    _smoothedCorners = rawCorners.map((p, i) => ({
        x: _smoothedCorners[i].x + (p.x - _smoothedCorners[i].x) * CORNER_SMOOTHING,
        y: _smoothedCorners[i].y + (p.y - _smoothedCorners[i].y) * CORNER_SMOOTHING
    }));
    return _smoothedCorners;
}

// Draws an outline around the detected QR code.
// Returns { centerX, bottomY } in display pixels for button placement, or null.
function _drawHighlight(videoEl, canvasEl, points) {
    if (!_overlayEl) return null;

    const dW = videoEl.clientWidth, dH = videoEl.clientHeight;
    if (_overlayEl.width !== dW || _overlayEl.height !== dH) {
        _overlayEl.width = dW;
        _overlayEl.height = dH;
    }

    const ctx = _overlayEl.getContext('2d');
    ctx.clearRect(0, 0, dW, dH);

    const { scaleX, scaleY, offsetX, offsetY } = _getDisplayTransform(videoEl, canvasEl);

    let corners;
    if (_capturingSampler && _capturingSampler.lastTransform && _capturingSampler.lastDimX > 0) {
        const t = _capturingSampler.lastTransform;
        const dimX = _capturingSampler.lastDimX;
        const dimY = _capturingSampler.lastDimY;
        const pts = new Float32Array([0, 0, dimX, 0, dimX, dimY, 0, dimY]);
        t.transformPoints(pts);
        corners = [
            { x: pts[0] * scaleX + offsetX, y: pts[1] * scaleY + offsetY },
            { x: pts[2] * scaleX + offsetX, y: pts[3] * scaleY + offsetY },
            { x: pts[4] * scaleX + offsetX, y: pts[5] * scaleY + offsetY },
            { x: pts[6] * scaleX + offsetX, y: pts[7] * scaleY + offsetY },
        ];
    } else if (points && points.length >= 3) {
        const dp = points.map(p => ({
            x: p.getX() * scaleX + offsetX,
            y: p.getY() * scaleY + offsetY
        }));
        const [bl, tl, tr] = dp;
        corners = [tl, tr, { x: tr.x + bl.x - tl.x, y: tr.y + bl.y - tl.y }, bl];
    } else {
        return null;
    }

    const [c0, c1, c2, c3] = _smoothCorners(corners);
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c3.x, c3.y);
    ctx.closePath();
    ctx.strokeStyle = '#7c6fff';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    return {
        centerX: (c0.x + c1.x + c2.x + c3.x) / 4,
        bottomY:  Math.max(c0.y, c1.y, c2.y, c3.y)
    };
}

function _drawCornersHighlight(videoEl, canvasEl, frameCorners) {
    if (!_overlayEl || !Array.isArray(frameCorners) || frameCorners.length < 4) return null;

    const dW = videoEl.clientWidth, dH = videoEl.clientHeight;
    if (_overlayEl.width !== dW || _overlayEl.height !== dH) {
        _overlayEl.width = dW;
        _overlayEl.height = dH;
    }

    const ctx = _overlayEl.getContext('2d');
    ctx.clearRect(0, 0, dW, dH);

    const { scaleX, scaleY, offsetX, offsetY } = _getDisplayTransform(videoEl, canvasEl);
    const corners = frameCorners.slice(0, 4).map(p => ({
        x: Number(p.x) * scaleX + offsetX,
        y: Number(p.y) * scaleY + offsetY
    }));
    if (corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

    const [c0, c1, c2, c3] = _smoothCorners(corners);
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c3.x, c3.y);
    ctx.closePath();
    ctx.strokeStyle = '#7c6fff';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    return {
        centerX: (c0.x + c1.x + c2.x + c3.x) / 4,
        bottomY:  Math.max(c0.y, c1.y, c2.y, c3.y)
    };
}

function _drawViewportCornersHighlight(viewportCorners) {
    if (!_overlayEl || !Array.isArray(viewportCorners) || viewportCorners.length < 4) return null;

    const dW = _overlayEl.clientWidth, dH = _overlayEl.clientHeight;
    if (_overlayEl.width !== dW || _overlayEl.height !== dH) {
        _overlayEl.width = dW;
        _overlayEl.height = dH;
    }

    const rect = _overlayEl.getBoundingClientRect();
    const corners = viewportCorners.slice(0, 4).map(p => ({
        x: Number(p.x) - rect.left,
        y: Number(p.y) - rect.top
    }));
    if (corners.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

    const ctx = _overlayEl.getContext('2d');
    ctx.clearRect(0, 0, _overlayEl.width, _overlayEl.height);

    const [c0, c1, c2, c3] = _smoothCorners(corners);
    ctx.beginPath();
    ctx.moveTo(c0.x, c0.y);
    ctx.lineTo(c1.x, c1.y);
    ctx.lineTo(c2.x, c2.y);
    ctx.lineTo(c3.x, c3.y);
    ctx.closePath();
    ctx.strokeStyle = '#7c6fff';
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    return {
        centerX: (c0.x + c1.x + c2.x + c3.x) / 4,
        bottomY:  Math.max(c0.y, c1.y, c2.y, c3.y)
    };
}

function _clearHighlight() {
    _smoothedCorners = null;
    if (!_overlayEl) return;
    const ctx = _overlayEl.getContext('2d');
    ctx.clearRect(0, 0, _overlayEl.width, _overlayEl.height);
}

function confirmScan() {
    if (!_pendingResult) return;
    const r = _pendingResult;
    _pendingResult = null;
    stopScanner();
    if (_onConfirm) _onConfirm(r);
}

function _snapshotBitMatrix(bitMatrix) {
    if (!bitMatrix) return null;
    const width = bitMatrix.getWidth();
    const height = bitMatrix.getHeight();
    return Array.from({ length: height }, (_, row) =>
        Array.from({ length: width }, (_, col) => bitMatrix.get(col, row))
    );
}

function stopScanner() {
    _cancelAutoConfirm();
    if (_nativeListener) {
        _nativeListener.remove();
        _nativeListener = null;
    }
    if (_usingNativeDetection) {
        try {
            _nativeDetectorPlugin()?.stop?.();
        } catch (_) {}
    }
    document.documentElement.classList.remove('native-camera-active');
    document.body.classList.remove('native-camera-active');
    document.getElementById('view-scanner')?.classList.remove('native-camera-active');
    _teardownPinchZoom();
    if (_torchBtn) {
        _torchBtn.onclick = null;
        _torchBtn.classList.add('hidden');
    }
    _setTorch(false);
    if (_animFrame) {
        cancelAnimationFrame(_animFrame);
        _animFrame = null;
    }
    if (_stream) {
        _stream.getTracks().forEach(t => t.stop());
        _stream = null;
    }
    _videoTrack = null;
    _cameraCaps = null;
    _nativeCaps = null;
    _torchBtn = null;
    _torchOn = false;
    _zoomApplying = false;
    _queuedZoom = null;
    _usingNativeDetection = false;
    _nativeDetecting = false;
    if (_canvasEl) _canvasEl.width = _canvasEl.height = 0;
    document.getElementById('scanner-video')?.classList.remove('video-ready');
    _pendingResult = null;
    _lastDetectionAt = 0;
    _stableText = null;
    _stableDecodeCount = 0;
    _clearHighlight();
}

function isScannerActive() {
    return !!_stream || _usingNativeDetection;
}

window.Scanner = { startScanner, stopScanner, isScannerActive };
