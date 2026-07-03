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

// How long the highlight stays visible before auto-confirming.
const AUTO_CONFIRM_DELAY_MS = 450;
const DETECTION_GRACE_MS = 500;
const AUTO_CONFIRM_FRESHNESS_MS = 200;
const STABLE_DECODE_FRAMES = 2;

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
    videoEl.classList.remove('video-ready');

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

    _capturingSampler = new CapturingGridSampler();
    ZXing.GridSamplerInstance.setGridSampler(_capturingSampler);
    _qrReader = new ZXing.QRCodeReader();
    _decodeHints = new Map([
        [ZXing.DecodeHintType.TRY_HARDER, true],
        [ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]],
    ]);

    _setupTorchButton();
    _setupPinchZoom(videoEl);
    _tick(videoEl, canvasEl);
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
    return Boolean(_videoTrack && _cameraCaps && _cameraCaps.torch);
}

async function _toggleTorch() {
    if (!_supportsTorch()) return;
    await _setTorch(!_torchOn);
}

async function _setTorch(on) {
    if (!_supportsTorch()) return;
    try {
        await _videoTrack.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
        _torchOn = Boolean(on);
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

function _supportsZoom() {
    const zoomCaps = _cameraCaps?.zoom;
    return Boolean(_videoTrack && zoomCaps && typeof zoomCaps.min === 'number' && typeof zoomCaps.max === 'number');
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
    const zoomCaps = _cameraCaps.zoom;
    const min = zoomCaps.min;
    const max = zoomCaps.max;
    const step = typeof zoomCaps.step === 'number' && zoomCaps.step > 0 ? zoomCaps.step : 0;
    let next = Math.min(max, Math.max(min, value));
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
    while (_queuedZoom !== null && _videoTrack) {
        const zoom = _queuedZoom;
        _queuedZoom = null;
        try {
            await _videoTrack.applyConstraints({ advanced: [{ zoom }] });
            _zoomValue = zoom;
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

            const text = result.getText();
            if (text === _stableText) {
                _stableDecodeCount++;
            } else {
                _stableText = text;
                _stableDecodeCount = 1;
                _cancelAutoConfirm();
            }

            _pendingResult = {
                text,
                bitMatrix: _capturingSampler.lastBits,
                rawModules: _capturingSampler.lastModules,
                rawBytes: typeof result.getRawBytes === 'function' ? result.getRawBytes() : null,
                snap: { canvas: clone, transform: _capturingSampler.lastTransform },
                detectedAt: performance.now()
            };

            const points = result.getResultPoints ? result.getResultPoints() : [];
            _drawHighlight(videoEl, canvasEl, points);
            _lastDetectionAt = _pendingResult.detectedAt;

            // Start the auto-confirm countdown once per detection window.
            // The highlight stays visible for AUTO_CONFIRM_DELAY_MS so the user
            // can see which code was scanned before the result screen appears.
            if (_stableDecodeCount >= STABLE_DECODE_FRAMES && !_autoConfirmTimer) {
                _autoConfirmTimer = setTimeout(_fireAutoConfirm, AUTO_CONFIRM_DELAY_MS);
            }
        } catch (_) {
            _pendingResult = null;
            _stableText = null;
            _stableDecodeCount = 0;
            _cancelAutoConfirm();
            if (performance.now() - _lastDetectionAt > DETECTION_GRACE_MS) {
                _clearHighlight();
            }
        }
    }
    _animFrame = requestAnimationFrame(() => _tick(videoEl, canvasEl));
}

function _cancelAutoConfirm() {
    if (!_autoConfirmTimer) return;
    clearTimeout(_autoConfirmTimer);
    _autoConfirmTimer = null;
}

function _fireAutoConfirm() {
    _autoConfirmTimer = null;
    if (!_pendingResult) return;

    if (
        _stableDecodeCount >= STABLE_DECODE_FRAMES &&
        _pendingResult.text === _stableText &&
        performance.now() - _pendingResult.detectedAt <= AUTO_CONFIRM_FRESHNESS_MS
    ) {
        confirmScan();
        return;
    }

    _pendingResult = null;
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

    const [c0, c1, c2, c3] = corners;
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
    if (!_overlayEl) return;
    const ctx = _overlayEl.getContext('2d');
    ctx.clearRect(0, 0, _overlayEl.width, _overlayEl.height);
}

function confirmScan() {
    if (!_pendingResult) return;
    const r = _pendingResult;
    _pendingResult = null;
    stopScanner();
    if (_onConfirm) _onConfirm(r.text, r.bitMatrix, r.rawBytes, r.snap, r.rawModules);
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
    _torchBtn = null;
    _torchOn = false;
    _zoomApplying = false;
    _queuedZoom = null;
    if (_canvasEl) _canvasEl.width = _canvasEl.height = 0;
    document.getElementById('scanner-video')?.classList.remove('video-ready');
    _pendingResult = null;
    _lastDetectionAt = 0;
    _stableText = null;
    _stableDecodeCount = 0;
    _clearHighlight();
}

function isScannerActive() {
    return !!_stream;
}

window.Scanner = { startScanner, stopScanner, isScannerActive };
