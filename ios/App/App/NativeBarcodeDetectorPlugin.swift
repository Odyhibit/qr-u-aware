import AVFoundation
import Capacitor
import CoreImage
import UIKit
import Vision

@objc(NativeBarcodeDetectorPlugin)
public class NativeBarcodeDetectorPlugin: CAPPlugin, CAPBridgedPlugin, AVCaptureVideoDataOutputSampleBufferDelegate {
    public let identifier = "NativeBarcodeDetectorPlugin"
    public let jsName = "NativeBarcodeDetector"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "detect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTorch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setZoom", returnType: CAPPluginReturnPromise)
    ]

    private let sessionQueue = DispatchQueue(label: "com.odyhibit.qruaware.native-scanner.session")
    private let visionQueue = DispatchQueue(label: "com.odyhibit.qruaware.native-scanner.vision")
    private let ciContext = CIContext()
    private var session: AVCaptureSession?
    private var captureDevice: AVCaptureDevice?
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var isProcessingFrame = false
    private var lastDetectionAt = Date.distantPast
    private var lastHitAt = Date.distantPast
    // How long after the last successful read we keep reporting misses. The JS
    // side only needs misses to clear a stale highlight (its grace window is
    // 500 ms); once nothing has been on screen this long there is nothing left
    // to clear, and staying silent keeps the Capacitor bridge log from being
    // flooded with {"found": false} every frame.
    private let missReportWindow: TimeInterval = 2.0
    private var previousWebViewOpaque: Bool?
    private var previousWebViewBackground: UIColor?
    private var previousScrollBackground: UIColor?
    private var previewFrame: CGRect?

    @objc func start(_ call: CAPPluginCall) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            startAuthorized(call)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    granted ? self.startAuthorized(call) : call.reject("Camera permission denied")
                }
            }
        default:
            call.reject("Camera permission denied")
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        stopSession()
        call.resolve()
    }

    @objc func setTorch(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false
        guard let device = captureDevice, device.hasTorch else {
            call.resolve(["on": false])
            return
        }
        sessionQueue.async {
            var applied = false
            do {
                try device.lockForConfiguration()
                device.torchMode = on ? .on : .off
                device.unlockForConfiguration()
                applied = true
            } catch {
                applied = false
            }
            DispatchQueue.main.async { call.resolve(["on": applied && on]) }
        }
    }

    @objc func setZoom(_ call: CAPPluginCall) {
        guard let device = captureDevice, let zoom = call.getDouble("zoom") else {
            call.resolve(["zoom": 1.0])
            return
        }
        sessionQueue.async {
            let maxZoom = device.activeFormat.videoMaxZoomFactor
            let clamped = max(1.0, min(CGFloat(zoom), maxZoom))
            do {
                try device.lockForConfiguration()
                device.videoZoomFactor = clamped
                device.unlockForConfiguration()
            } catch {
                // best effort — leave zoom at whatever it currently is
            }
            let appliedZoom = device.videoZoomFactor
            DispatchQueue.main.async { call.resolve(["zoom": appliedZoom]) }
        }
    }

    @objc func detect(_ call: CAPPluginCall) {
        guard let imageData = call.getString("image"),
              let image = decodeImage(imageData),
              let cgImage = image.cgImage else {
            call.reject("Invalid image")
            return
        }

        let request = VNDetectBarcodesRequest { request, error in
            if let error = error {
                call.reject("Native barcode detection failed", nil, error)
                return
            }

            let observations = (request.results as? [VNBarcodeObservation]) ?? []
            guard let qr = observations.first(where: { $0.symbology == .qr && $0.payloadStringValue != nil }) else {
                call.resolve([
                    "found": false,
                    "width": cgImage.width,
                    "height": cgImage.height
                ])
                return
            }

            call.resolve(self.resultObject(for: qr, width: cgImage.width, height: cgImage.height))
        }
        request.symbologies = [.qr]

        visionQueue.async {
            do {
                try VNImageRequestHandler(cgImage: cgImage, orientation: self.cgOrientation(for: image.imageOrientation)).perform([request])
            } catch {
                call.reject("Native barcode detection failed", nil, error)
            }
        }
    }

    private func startAuthorized(_ call: CAPPluginCall) {
        previewFrame = rectFromCall(call, key: "previewRect")
        makeWebViewTransparent()
        attachPreviewLayer()

        sessionQueue.async {
            do {
                let session = try self.makeSession()
                self.session = session
                // Must run synchronously: attaching a session to a preview layer makes
                // AVFoundation perform its own internal begin/commitConfiguration on the
                // session. If startRunning() below fires while that's in flight (which an
                // async dispatch here permits), the session throws "startRunning may not be
                // called between calls to beginConfiguration and commitConfiguration".
                DispatchQueue.main.sync {
                    self.previewLayer?.session = session
                    self.previewLayer?.frame = self.currentPreviewFrame()
                    // Only affects how the live video image is visually rendered inside the
                    // layer — unrelated to the highlight math in previewPoint(), which uses
                    // only layer.bounds/layer.convert(_:to:) (plain geometry, no dependency
                    // on connection orientation).
                    if let previewConnection = self.previewLayer?.connection {
                        self.applyPortraitOrientation(to: previewConnection)
                    }
                }
                session.startRunning()
                let device = self.captureDevice
                call.resolve([
                    "hasTorch": device?.hasTorch ?? false,
                    "minZoom": 1.0,
                    "maxZoom": Double(device?.activeFormat.videoMaxZoomFactor ?? 1.0)
                ])
            } catch {
                DispatchQueue.main.async {
                    self.restoreWebViewAppearance()
                    self.previewLayer?.removeFromSuperlayer()
                    self.previewLayer = nil
                }
                call.reject("Could not start native camera", nil, error)
            }
        }
    }

    private func makeSession() throws -> AVCaptureSession {
        let session = AVCaptureSession()
        session.beginConfiguration()
        session.sessionPreset = .high

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else {
            throw NativeScannerError.noCamera
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw NativeScannerError.cannotAddInput }
        session.addInput(input)
        captureDevice = device

        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
        output.setSampleBufferDelegate(self, queue: visionQueue)
        guard session.canAddOutput(output) else { throw NativeScannerError.cannotAddOutput }
        session.addOutput(output)

        // Deliberately not setting any orientation/rotation on this connection: whether
        // videoOrientation/videoRotationAngle actually physically rotates the delivered
        // CVPixelBuffer has proven inconsistent to reason about across iOS versions. We
        // instead read the buffer's actual dimensions in captureOutput each frame and
        // adapt to whatever shape it really is, removing the guesswork entirely.

        session.commitConfiguration()
        return session
    }

    private func applyPortraitOrientation(to connection: AVCaptureConnection) {
        if #available(iOS 17.0, *) {
            if connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90
            }
        } else if connection.isVideoOrientationSupported {
            connection.videoOrientation = .portrait
        }
    }

    private func attachPreviewLayer() {
        DispatchQueue.main.async {
            guard let hostView = self.bridge?.viewController?.view else { return }
            if self.previewLayer == nil {
                let layer = AVCaptureVideoPreviewLayer()
                layer.videoGravity = .resizeAspectFill
                self.previewLayer = layer
            }
            guard let previewLayer = self.previewLayer else { return }
            previewLayer.frame = self.currentPreviewFrame()
            if previewLayer.superlayer == nil {
                hostView.layer.insertSublayer(previewLayer, at: 0)
            }
        }
    }

    private func currentPreviewFrame() -> CGRect {
        guard let hostView = bridge?.viewController?.view else { return .zero }
        return previewFrame ?? hostView.bounds
    }

    private func rectFromCall(_ call: CAPPluginCall, key: String) -> CGRect? {
        guard let rect = call.getObject(key),
              let x = numberValue(rect["x"]),
              let y = numberValue(rect["y"]),
              let width = numberValue(rect["width"]),
              let height = numberValue(rect["height"]),
              width > 0,
              height > 0 else {
            return nil
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func numberValue(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let double = value as? Double { return double }
        if let int = value as? Int { return Double(int) }
        return nil
    }

    private func makeWebViewTransparent() {
        DispatchQueue.main.async {
            guard let webView = self.webView else { return }
            if self.previousWebViewOpaque == nil {
                self.previousWebViewOpaque = webView.isOpaque
                self.previousWebViewBackground = webView.backgroundColor
                self.previousScrollBackground = webView.scrollView.backgroundColor
            }
            webView.isOpaque = false
            webView.backgroundColor = .clear
            webView.scrollView.backgroundColor = .clear
            webView.scrollView.subviews.forEach { $0.backgroundColor = .clear }
        }
    }

    private func restoreWebViewAppearance() {
        guard let webView = webView else { return }
        if let opaque = previousWebViewOpaque {
            webView.isOpaque = opaque
        }
        webView.backgroundColor = previousWebViewBackground
        webView.scrollView.backgroundColor = previousScrollBackground
        previousWebViewOpaque = nil
        previousWebViewBackground = nil
        previousScrollBackground = nil
    }

    private func stopSession() {
        sessionQueue.async {
            if let device = self.captureDevice, device.hasTorch, device.torchMode != .off {
                do {
                    try device.lockForConfiguration()
                    device.torchMode = .off
                    device.unlockForConfiguration()
                } catch {
                    // best effort — session is tearing down regardless
                }
            }
            self.session?.stopRunning()
            self.session = nil
            self.captureDevice = nil
            self.isProcessingFrame = false
            DispatchQueue.main.async {
                self.previewLayer?.session = nil
                self.previewLayer?.removeFromSuperlayer()
                self.previewLayer = nil
                self.previewFrame = nil
                self.restoreWebViewAppearance()
            }
        }
    }

    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if isProcessingFrame { return }
        if Date().timeIntervalSince(lastDetectionAt) < 0.08 { return }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        isProcessingFrame = true

        // Measure the buffer instead of assuming: the back camera's raw sensor buffer is
        // landscape (wider than tall) when the device is held in portrait, regardless of
        // whether any connection orientation setting "should" have rotated it. A
        // wider-than-tall buffer needs Vision's .right correction (and its content size,
        // once upright, is the buffer with width/height swapped); a taller-than-wide
        // buffer is already portrait-upright and needs no correction.
        let bufferWidth = CGFloat(CVPixelBufferGetWidth(pixelBuffer))
        let bufferHeight = CGFloat(CVPixelBufferGetHeight(pixelBuffer))
        let isRawLandscape = bufferWidth > bufferHeight
        let orientation: CGImagePropertyOrientation = isRawLandscape ? .right : .up
        let contentWidth = isRawLandscape ? bufferHeight : bufferWidth
        let contentHeight = isRawLandscape ? bufferWidth : bufferHeight

        let request = VNDetectBarcodesRequest { request, _ in
            defer { self.isProcessingFrame = false }
            self.lastDetectionAt = Date()

            let observations = (request.results as? [VNBarcodeObservation]) ?? []
            guard let qr = observations.first(where: { $0.symbology == .qr && $0.payloadStringValue != nil }) else {
                // Must still notify on a miss shortly after a hit — the JS side clears the
                // stale highlight and resets its stability tracking off this event. Without
                // it, a QR that reads once and then fails on later frames (typical for a
                // damaged/marginal code) leaves the last outline frozen on screen forever.
                // Once no code has been seen for missReportWindow, go silent instead of
                // spamming the bridge with a miss event per frame.
                if Date().timeIntervalSince(self.lastHitAt) < self.missReportWindow {
                    DispatchQueue.main.async {
                        self.notifyListeners("barcodeDetected", data: ["found": false])
                    }
                }
                return
            }
            self.lastHitAt = Date()

            // Build the full payload (including the rectified module-grid crop) here,
            // still on visionQueue, while pixelBuffer is guaranteed valid — only plain
            // JS-serializable data crosses the dispatch to the main thread below.
            let payload = self.liveResultObject(
                for: qr,
                contentWidth: contentWidth,
                contentHeight: contentHeight,
                pixelBuffer: pixelBuffer,
                orientation: orientation
            )
            DispatchQueue.main.async {
                self.notifyListeners("barcodeDetected", data: payload)
            }
        }
        request.symbologies = [.qr]

        do {
            try VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: orientation, options: [:]).perform([request])
        } catch {
            isProcessingFrame = false
        }
    }

    private func liveResultObject(
        for observation: VNBarcodeObservation,
        contentWidth: CGFloat,
        contentHeight: CGFloat,
        pixelBuffer: CVPixelBuffer,
        orientation: CGImagePropertyOrientation
    ) -> JSObject {
        var result: JSObject = [
            "found": true,
            "text": observation.payloadStringValue ?? "",
            "corners": previewCorners(for: observation, contentWidth: contentWidth, contentHeight: contentHeight)
        ]
        if let descriptor = observation.barcodeDescriptor as? CIQRCodeDescriptor {
            result["rawBytes"] = Array(descriptor.errorCorrectedPayload).map { Int($0) }
            result["version"] = descriptor.symbolVersion
            result["mask"] = Int(descriptor.maskPattern)
            result["eccLevel"] = eccLevelString(descriptor.errorCorrectionLevel)

            let moduleCount = descriptor.symbolVersion * 4 + 17
            if let moduleImage = rectifiedModuleImageDataURL(
                pixelBuffer: pixelBuffer,
                orientation: orientation,
                observation: observation,
                moduleCount: moduleCount
            ) {
                result["moduleImage"] = moduleImage
                result["moduleCount"] = moduleCount
            }
        }
        return result
    }

    // Vision only exposes the corrected *data* codewords (errorCorrectedPayload), not the
    // raw module grid or the ECC codewords — so ECC-level analysis (error count, ECC-hidden
    // secrets) isn't derivable from Vision's result alone. This rectifies just the QR symbol
    // out of the camera frame using the same corner points Vision already detected, via
    // Core Image's own perspective-correction filter rather than hand-rolled homography math.
    // JS then samples this straight-on crop directly (module i,j -> pixel (i,j) at a fixed
    // per-module scale, no further transform needed) to rebuild the real module grid, which
    // feeds the exact same analysis path already used for the ZXing/web scanner.
    private func rectifiedModuleImageDataURL(
        pixelBuffer: CVPixelBuffer,
        orientation: CGImagePropertyOrientation,
        observation: VNBarcodeObservation,
        moduleCount: Int
    ) -> String? {
        guard moduleCount > 0 else { return nil }
        let pxPerModule = max(3, min(6, 800 / moduleCount))
        let outputSize = CGFloat(moduleCount * pxPerModule)

        let oriented = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
        let extent = oriented.extent

        // Vision's corner points and CIImage's own coordinate space are both normalized/
        // measured with origin at bottom-left, so no axis flip is needed — just scale
        // Vision's 0...1 corners up to the oriented image's actual pixel extent.
        func imagePoint(_ p: CGPoint) -> CGPoint {
            CGPoint(x: p.x * extent.width, y: p.y * extent.height)
        }

        guard let filter = CIFilter(name: "CIPerspectiveCorrection") else { return nil }
        filter.setValue(oriented, forKey: kCIInputImageKey)
        filter.setValue(CIVector(cgPoint: imagePoint(observation.topLeft)), forKey: "inputTopLeft")
        filter.setValue(CIVector(cgPoint: imagePoint(observation.topRight)), forKey: "inputTopRight")
        filter.setValue(CIVector(cgPoint: imagePoint(observation.bottomRight)), forKey: "inputBottomRight")
        filter.setValue(CIVector(cgPoint: imagePoint(observation.bottomLeft)), forKey: "inputBottomLeft")

        guard let corrected = filter.outputImage,
              corrected.extent.width > 0, corrected.extent.height > 0,
              corrected.extent.width.isFinite, corrected.extent.height.isFinite else {
            return nil
        }

        // Force to an exact square at a fixed per-module pixel scale so JS can sample
        // module centers with a plain row/col -> pixel lookup, no further transform.
        let scale = CGAffineTransform(
            scaleX: outputSize / corrected.extent.width,
            y: outputSize / corrected.extent.height
        )
        let squared = corrected.transformed(by: scale)

        guard let cgImage = ciContext.createCGImage(
            squared, from: CGRect(x: 0, y: 0, width: outputSize, height: outputSize)
        ) else {
            return nil
        }

        let uiImage = UIImage(cgImage: cgImage)
        guard let jpegData = uiImage.jpegData(compressionQuality: 0.85) else { return nil }
        return "data:image/jpeg;base64,\(jpegData.base64EncodedString())"
    }

    private func resultObject(for observation: VNBarcodeObservation, width: Int, height: Int) -> JSObject {
        var result: JSObject = [
            "found": true,
            "text": observation.payloadStringValue ?? "",
            "width": width,
            "height": height,
            "corners": imageCorners(for: observation, width: width, height: height)
        ]
        if let descriptor = observation.barcodeDescriptor as? CIQRCodeDescriptor {
            result["rawBytes"] = Array(descriptor.errorCorrectedPayload).map { Int($0) }
            result["version"] = descriptor.symbolVersion
            result["mask"] = Int(descriptor.maskPattern)
            result["eccLevel"] = eccLevelString(descriptor.errorCorrectionLevel)
        }
        return result
    }

    private func previewCorners(for observation: VNBarcodeObservation, contentWidth: CGFloat, contentHeight: CGFloat) -> [[String: CGFloat]] {
        guard let previewLayer = previewLayer else { return [] }
        return [
            previewPoint(observation.topLeft, contentWidth: contentWidth, contentHeight: contentHeight, in: previewLayer),
            previewPoint(observation.topRight, contentWidth: contentWidth, contentHeight: contentHeight, in: previewLayer),
            previewPoint(observation.bottomRight, contentWidth: contentWidth, contentHeight: contentHeight, in: previewLayer),
            previewPoint(observation.bottomLeft, contentWidth: contentWidth, contentHeight: contentHeight, in: previewLayer)
        ]
    }

    // Reimplements object-fit: cover / resizeAspectFill by hand, the same way the JS/ZXing
    // path's _getDisplayTransform() already does successfully, instead of trusting
    // AVFoundation's layerPointConverted(fromCaptureDevicePoint:) or layerRectConverted
    // (fromMetadataOutputRect:) — both depend on connection orientation settings whose
    // actual effect on the delivered buffer proved unreliable to reason about here.
    // layer.convert(_:to:) is plain Core Animation geometry (unrelated to video
    // orientation) and just walks the layer's own transform up to window coordinates.
    private func previewPoint(_ p: CGPoint, contentWidth: CGFloat, contentHeight: CGFloat, in layer: AVCaptureVideoPreviewLayer) -> [String: CGFloat] {
        let nx = p.x
        let ny = 1 - p.y

        let dW = layer.bounds.width
        let dH = layer.bounds.height
        guard dW > 0, dH > 0, contentWidth > 0, contentHeight > 0 else {
            return ["x": 0, "y": 0]
        }

        let scale: CGFloat
        let offsetX: CGFloat
        let offsetY: CGFloat
        if contentWidth / contentHeight > dW / dH {
            scale = dH / contentHeight
            offsetX = (dW - contentWidth * scale) / 2
            offsetY = 0
        } else {
            scale = dW / contentWidth
            offsetX = 0
            offsetY = (dH - contentHeight * scale) / 2
        }

        let localPoint = CGPoint(x: offsetX + nx * contentWidth * scale, y: offsetY + ny * contentHeight * scale)
        let screenPoint = layer.convert(localPoint, to: nil)
        return ["x": screenPoint.x, "y": screenPoint.y]
    }

    private func imageCorners(for observation: VNBarcodeObservation, width: Int, height: Int) -> [[String: CGFloat]] {
        return [
            imagePoint(observation.topLeft, width: width, height: height),
            imagePoint(observation.topRight, width: width, height: height),
            imagePoint(observation.bottomRight, width: width, height: height),
            imagePoint(observation.bottomLeft, width: width, height: height)
        ]
    }

    private func imagePoint(_ p: CGPoint, width: Int, height: Int) -> [String: CGFloat] {
        return [
            "x": p.x * CGFloat(width),
            "y": (1 - p.y) * CGFloat(height)
        ]
    }

    private func eccLevelString(_ level: CIQRCodeDescriptor.ErrorCorrectionLevel) -> String {
        switch level {
        case .levelL: return "L"
        case .levelM: return "M"
        case .levelQ: return "Q"
        case .levelH: return "H"
        @unknown default: return "M"
        }
    }

    private func decodeImage(_ imageData: String) -> UIImage? {
        let payload = imageData.split(separator: ",", maxSplits: 1).last.map(String.init) ?? imageData
        guard let data = Data(base64Encoded: payload) else { return nil }
        return UIImage(data: data)
    }

    private func cgOrientation(for orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
        switch orientation {
        case .up: return .up
        case .down: return .down
        case .left: return .left
        case .right: return .right
        case .upMirrored: return .upMirrored
        case .downMirrored: return .downMirrored
        case .leftMirrored: return .leftMirrored
        case .rightMirrored: return .rightMirrored
        @unknown default: return .up
        }
    }
}

private enum NativeScannerError: Error {
    case noCamera
    case cannotAddInput
    case cannotAddOutput
}
