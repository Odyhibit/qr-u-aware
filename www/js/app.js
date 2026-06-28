// State machine: 'scanner' | 'result' | 'history'
let _view = 'scanner';
let _lastScan = null; // { content, contentType, version, eccLevel, maskPattern, padSecret, eccSecret, savedId }
let _safetyRunId = 0;
let _lastResolution = null;
let _safetyDetailsTarget = 'content';
let _historyCache = null;
let _historyLoadPromise = null;
const COLLAPSE_TEXT_LENGTH = 140;

const _UA_IOS     = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const _UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const _UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const _SMART_LINK_HOSTS = new Set([
    'onelink.to', 'go.onelink.me',
    'app.link', 'bnc.lt',
    'page.link',
    'adj.st', 'a.adj.st',
]);
const _SHORT_LINK_HOSTS = new Set([
    ..._SMART_LINK_HOSTS,
    'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly',
    'rebrand.ly', 'cutt.ly', 'shorturl.at', 'scanned.page', 'view.page', 'qrco.de',
    'qr-codes.io', 'qr.w69b.com',  // Uniqode (formerly Beaconstac/w69b) dynamic QR platform
    'qr1.be',                       // QR Tiger dynamic QR platform
    'l.ead.me',                     // QR Code Generator (qr-code-generator.com)
    'go.adobe.io',                  // Adobe Express (tracking-enabled QR codes)
    'flowsto.com', 'flow2.it',      // Flowcode dynamic QR platform
    'hov.to', 'hovqr.co',          // Hovercode dynamic QR platform
    'mondlz.com',  // Mondelez International (Oreo, Ritz, Cadbury packaging QR codes)
    'costco.ms',   // Costco (HTTP-only shortener domain, redirects to costco.com)
]);
const _COMMON_SECOND_LEVEL_TLDS = new Set(['ac', 'co', 'com', 'edu', 'gov', 'net', 'org']);
const _DOMAIN_AGE_CACHE_PREFIX = 'qr_domain_age_v2_';
const _RDAP_BOOTSTRAP_CACHE_KEY = 'qr_rdap_dns_bootstrap';
const _DOMAIN_AGE_SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const _DOMAIN_AGE_ERROR_TTL_MS = 24 * 60 * 60 * 1000;

// ── View switching ───────────────────────────────────────────────────────────

function showView(name) {
    _view = name;
    document.getElementById('view-scanner').classList.toggle('hidden', name !== 'scanner');
    document.getElementById('view-result').classList.toggle('hidden', name !== 'result');
    document.getElementById('view-history').classList.toggle('hidden', name !== 'history');
    document.getElementById('view-settings').classList.toggle('hidden', name !== 'settings');

    if (name === 'scanner' && !Scanner.isScannerActive()) {
        startCamera();
    }
    if (name !== 'scanner' && Scanner.isScannerActive()) {
        Scanner.stopScanner();
    }
    if (name === 'history') {
        showHistoryLoading();
        requestAnimationFrame(() => loadHistory());
    }
    if (name === 'settings') {
        initSettings();
    }

    // Result is part of the scanner flow — keep Scanner tab lit while it's showing.
    document.getElementById('tab-scanner').classList.toggle('tab-active', name === 'scanner' || name === 'result');
    document.getElementById('tab-history').classList.toggle('tab-active', name === 'history');
    document.getElementById('tab-settings').classList.toggle('tab-active', name === 'settings');
}

// ── Camera ───────────────────────────────────────────────────────────────────

async function startCamera() {
    const video = document.getElementById('scanner-video');
    const canvas = document.getElementById('scanner-canvas');
    const overlay = document.getElementById('qr-overlay-canvas');
    document.getElementById('scanner-error').classList.add('hidden');
    try {
        await Scanner.startScanner(video, canvas, overlay, onQRDetected);
    } catch (err) {
        document.getElementById('scanner-error').classList.remove('hidden');
        document.getElementById('scanner-error-msg').textContent =
            err.name === 'NotAllowedError'
                ? 'Camera permission denied. Please allow camera access and reload.'
                : 'Camera unavailable: ' + err.message;
    }
}

// ── QR detected ─────────────────────────────────────────────────────────────

async function onQRDetected(rawText, bitMatrix, rawBytes, debugSnap) {
    let stegoResult = { version: '?', eccLevel: '?', maskPattern: '?', padSecret: null, eccSecret: null, errorsFound: null, dataCodewords: [], eccCodewords: [], paddingOffset: 0 };
    try {
        const decoded = await QRStego.decode({
            bitMatrix,
            rawBytes,
            expectedText: rawText,
            extractPadding: true,
            extractECC: true,
            sampleCanvas: debugSnap ? debugSnap.canvas : null,
            sampleTransform: debugSnap ? debugSnap.transform : null
        });
        stegoResult = {
            version: decoded.version,
            eccLevel: decoded.eccLevel,
            maskPattern: decoded.mask,
            padSecret: sanitizeStegoSecret(decoded.paddingSecret),
            eccSecret: sanitizeStegoSecret(decoded.eccSecret),
            errorsFound: decoded.errorsFound ?? null,
            dataCodewords: decoded.dataCodewords || [],
            eccCodewords:  decoded.eccCodewords  || [],
            paddingOffset: decoded.paddingOffset  ?? 0
        };
    } catch (_) {
        // stego decode failed — show basic result anyway
    }

    const contentType = detectContentType(rawText);
    const localRisk = contentType === 'url' ? analyzeLocalUrlRisks(rawText) : { level: 'none', labels: [] };

    _lastScan = {
        content: rawText,
        contentType,
        localRiskLevel: localRisk.level,
        localRiskLabels: localRisk.labels,
        ...stegoResult
    };

    // Auto-save to DB
    try {
        const savedId = await ScanDB.saveScan(_lastScan);
        _lastScan.savedId = savedId;
        addScanToHistoryCache(_lastScan);
    } catch (_) {}

    renderResult(_lastScan);
    showView('result');
}

function sanitizeStegoSecret(secret) {
    if (secret === null || secret === undefined) return null;

    const trimmed = String(secret).replace(/^[\u0000\s]+|[\u0000\s]+$/g, '');
    if (!trimmed) return null;
    if (trimmed.includes('\uFFFD')) return null;

    const chars = Array.from(trimmed);
    let printable = 0;
    let visible = 0;
    for (const ch of chars) {
        const cp = ch.codePointAt(0);
        const isAllowedControl = cp === 0x09 || cp === 0x0A || cp === 0x0D;
        const isControl = cp < 0x20 || (cp >= 0x7F && cp <= 0x9F);
        const isPrintable = !isControl || isAllowedControl;
        if (isPrintable) printable++;
        if (!isAllowedControl && !/\s/u.test(ch)) visible++;
    }

    if (visible < 3) return null;
    if (printable / chars.length < 0.9) return null;
    return trimmed;
}

// ── Content type detection ───────────────────────────────────────────────────

function detectContentType(text) {
    if (isLikelyWebUrl(text)) return 'url';
    if (/^mailto:/i.test(text)) return 'email';
    if (/^tel:/i.test(text)) return 'phone';
    if (/^BEGIN:VCARD/i.test(text)) return 'vcard';
    if (/^WIFI:/i.test(text)) return 'wifi';
    if (/^smsto:|^sms:/i.test(text)) return 'sms';
    if (/^geo:/i.test(text)) return 'geo';
    return 'text';
}

function isLikelyWebUrl(text) {
    const trimmed = String(text || '').trim();
    if (/^https?:\/\//i.test(trimmed)) return true;
    if (/\s/.test(trimmed)) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return false;
    if (/^www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#].*)?$/i.test(trimmed)) return true;
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+[/:?#][^\s]*$/i.test(trimmed)) return true;
    // Bare domain.tld with no path (e.g. "aadvantage.com" from airline seat QRs).
    // TLD must be letters-only so version strings like "v1.2" and "1.0" are excluded.
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/i.test(trimmed);
}

function analyzeLocalUrlRisks(text, { checkHttp = false } = {}) {
    const risks = [];
    const raw = String(text || '').trim();
    let url;
    try {
        url = new URL(normalizeUrl(raw));
    } catch (_) {
        return { level: 'warn', labels: ['Invalid URL'] };
    }

    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    if (checkHttp && /^http:\/\//i.test(raw)) risks.push({ level: 'warn', label: 'HTTP' });
    if (url.username || url.password) risks.push({ level: 'threat', label: 'Embedded credentials' });
    if (host.startsWith('xn--') || host.includes('.xn--')) risks.push({ level: 'warn', label: 'Punycode domain' });
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) risks.push({ level: 'warn', label: 'IP address' });
    if (_SHORT_LINK_HOSTS.has(host) || _isSmartLinkHost(host)) {
        risks.push({ level: 'info', label: 'Redirect service' });
    }
    if (url.search.length > 90) risks.push({ level: 'info', label: 'Long query' });
    if (/[?&](token|auth|session|key|code|ticket|redirect|url|continue|next)=/i.test(url.search)) {
        risks.push({ level: 'info', label: 'Sensitive parameter' });
    }

    const level = risks.some(r => r.level === 'threat') ? 'threat'
        : risks.some(r => r.level === 'warn') ? 'warn'
        : risks.some(r => r.level === 'info') ? 'info'
        : 'safe';
    return { level, labels: risks.map(r => r.label) };
}

// ── Simple mode ──────────────────────────────────────────────────────────────

let _resultViewMode = 'simple';
let _safetyCheckState = 'idle'; // 'idle' | 'checking' | 'unreachable' | 'done'

function _applyResultViewMode() {
    const isSimple = _resultViewMode === 'simple';
    document.getElementById('view-result').classList.toggle('simple-mode', isSimple);
    const pill = document.getElementById('result-mode-pill');
    if (pill) pill.textContent = isSimple ? 'Details ›' : '‹ Simple';
}

function toggleResultMode() {
    _resultViewMode = _resultViewMode === 'simple' ? 'advanced' : 'simple';
    _applyResultViewMode();
}

function _simpleContentSub(scan) {
    const c = scan.content || '';
    let sub;
    switch (scan.contentType) {
        case 'email': sub = c.replace(/^mailto:/i, '').split('?')[0]; break;
        case 'phone': sub = c.replace(/^tel:/i, ''); break;
        case 'sms':   sub = c.replace(/^s(?:ms(?:to)?|msto):/i, '').split(/[?:]/)[0]; break;
        case 'wifi':  { const m = c.match(/S:([^;]+)/); sub = m ? m[1] : c; break; }
        case 'vcard': { const m = c.match(/FN:([^\r\n]+)/); sub = m ? m[1].trim() : null; break; }
        case 'geo':   { const m = c.match(/^geo:([0-9.,\-]+)/i); sub = m ? m[1] : c; break; }
        default:      sub = c;
    }
    if (!sub) return null;
    return sub.length > 55 ? sub.slice(0, 52) + '…' : sub;
}

function _computeSimpleVerdict(scan) {
    if (scan.contentType !== 'url') {
        return { level: 'neutral', icon: '○', text: _contentTypeLabel(scan.contentType), sub: _simpleContentSub(scan) };
    }

    if (_safetyCheckState === 'checking') {
        return { level: 'checking', icon: '', text: 'Checking…', sub: _simpleDomain(scan) };
    }

    if (_safetyCheckState === 'unreachable') {
        const hasGsbData = scan.googleVerdict &&
            scan.googleVerdict !== 'No key configured' &&
            scan.googleVerdict !== 'Check failed' &&
            scan.googleVerdict !== 'Partially checked';
        const hasOtherData = scan.domainAgeVerdict || scan.vtVerdict;
        if (!hasGsbData && !hasOtherData) {
            return { level: 'unreachable', icon: '?', text: "Couldn't Verify Site", sub: _simpleDomain(scan) };
        }
        // At least one check completed — evaluate on available signals below.
    }

    const localThreat = scan.localRiskLevel === 'threat' || scan.finalLocalRiskLevel === 'threat';
    const gsbThreat = scan.googleVerdict &&
        scan.googleVerdict !== 'No key configured' &&
        scan.googleVerdict !== 'Check failed' &&
        scan.googleVerdict !== 'Not known malicious' &&
        scan.googleVerdict !== 'Partially checked';
    const vtThreat = scan.vtVerdict && scan.vtVerdict.toLowerCase().startsWith('threat');

    if (localThreat || gsbThreat || vtThreat) {
        return { level: 'danger', icon: '✕', text: "Don't Open This", sub: _simpleDomain(scan) };
    }

    const localWarn = scan.localRiskLevel === 'warn' || scan.finalLocalRiskLevel === 'warn';
    const domainYoung = scan.domainAgeLevel === 'warn' || scan.domainAgeLevel === 'danger';
    const vtSuspicious = scan.vtVerdict && scan.vtVerdict.toLowerCase().startsWith('warning');

    if (localWarn || domainYoung || vtSuspicious) {
        return { level: 'caution', icon: '⚠', text: 'Use Caution', sub: _simpleDomain(scan) };
    }

    return { level: 'safe', icon: '✓', text: 'Looks Safe', sub: _simpleDomain(scan) };
}

function _contentTypeLabel(type) {
    return { email: 'Email Address', phone: 'Phone Number', vcard: 'Contact Card',
             wifi: 'Wi-Fi Credentials', sms: 'Text Message', geo: 'Location',
             text: 'Text Content' }[type] || 'QR Content';
}

function _simpleDomain(scan) {
    const url = scan.finalUrl || scan.content;
    try { return new URL(normalizeUrl(url)).hostname.replace(/^www\./, ''); }
    catch (_) { return null; }
}

function _updateSimpleVerdict() {
    if (!_lastScan) return;
    const v = _computeSimpleVerdict(_lastScan);
    const card = document.getElementById('simple-verdict-card');
    const iconEl = document.getElementById('simple-verdict-icon');
    const textEl = document.getElementById('simple-verdict-text');
    const subEl  = document.getElementById('simple-verdict-sub');
    if (!card) return;
    card.className = `simple-verdict-card verdict-${v.level}`;
    iconEl.textContent = v.icon;
    textEl.textContent = v.text;
    subEl.textContent  = v.sub || '';

    const reasonEl = document.getElementById('simple-verdict-reason');
    if (reasonEl) {
        const reasons = (v.level === 'caution' || v.level === 'danger')
            ? _computeSimpleReasons(_lastScan)
            : [];
        if (reasons.length) {
            reasonEl.textContent = reasons.join(' · ');
            reasonEl.className = `simple-verdict-reason reason-${v.level}`;
        } else {
            reasonEl.textContent = '';
            reasonEl.className = 'simple-verdict-reason hidden';
        }
    }

    const openBtn = document.getElementById('simple-open-btn');
    if (openBtn) openBtn.classList.toggle('hidden', _lastScan.contentType !== 'url');
}

function _computeSimpleReasons(scan) {
    const reasons = [];

    if (scan.localRiskLevel === 'warn' || scan.localRiskLevel === 'threat') {
        reasons.push(...(scan.localRiskLabels || []));
    }
    if (scan.finalLocalRiskLevel === 'warn' || scan.finalLocalRiskLevel === 'threat') {
        reasons.push(...(scan.finalLocalRiskLabels || []));
    }

    if ((scan.domainAgeLevel === 'warn' || scan.domainAgeLevel === 'danger') && scan.domainAgeVerdict) {
        reasons.push(scan.domainAgeVerdict);
    }

    const gsbPositive = ['No key configured', 'Check failed', 'Not known malicious', 'Partially checked'];
    if (scan.googleVerdict && !gsbPositive.includes(scan.googleVerdict)) {
        reasons.push(`Google: ${scan.googleVerdict}`);
    }

    if (scan.vtVerdict &&
        (scan.vtVerdict.toLowerCase().startsWith('threat') || scan.vtVerdict.toLowerCase().startsWith('warning'))) {
        reasons.push(scan.vtVerdict);
    }

    return [...new Set(reasons)];
}

function simpleOpenUrl() {
    if (!_lastScan) return;
    window.open(_lastScan.finalUrl || normalizeUrl(_lastScan.content), '_blank');
}

// ── Result rendering ─────────────────────────────────────────────────────────

function _simpleModePrefsSatisfied() {
    const prefs = typeof getNetworkPreferences === 'function' ? getNetworkPreferences() : {};
    return prefs.autoRedirects && prefs.autoGsb && prefs.autoDomainAge;
}

function renderResult(scan) {
    const wantsSimple = !(typeof isAdvancedMode === 'function' && isAdvancedMode());
    _resultViewMode = (wantsSimple && (scan.contentType !== 'url' || _simpleModePrefsSatisfied()))
        ? 'simple' : 'advanced';
    _safetyCheckState = scan.contentType === 'url' ? 'checking' : 'done';
    _applyResultViewMode();
    _updateSimpleVerdict();

    setCollapsibleText(document.getElementById('result-content'), scan.content);

    // Content-type badge & URL button
    const badge = document.getElementById('result-type-badge');
    badge.textContent = scan.contentType.toUpperCase();
    badge.className = `badge badge-${scan.contentType}`;

    const urlBtn = document.getElementById('result-open-url');
    document.getElementById('result-resolved-section').classList.add('hidden');
    document.getElementById('result-redirect-loading').classList.add('hidden');
    document.getElementById('result-safety-details').classList.add('hidden');
    document.getElementById('result-safety-detail-list').innerHTML = '';
    _hideDomainAge();
    _safetyDetailsTarget = 'content';
    _moveSafetyDetails('content');
    _setSafetyDetailsTitle('Google Safe Browsing', '');
    _clearNetworkPrompt();
    _hideVirusTotalResult();
    _lastResolution = null;
    document.getElementById('result-dest-local-checks')?.classList.add('hidden');
    renderLocalChecks(scan);
    _refreshStoredDomainAge(scan);
    if (scan.domainAgeVerdict) {
        _renderDomainAgeResult({
            domain: scan.domainAgeDomain,
            registeredAt: scan.domainAgeRegisteredAt,
            verdict: scan.domainAgeVerdict,
            level: scan.domainAgeLevel || 'muted',
            fromCache: true
        });
    }

    if (scan.contentType === 'url') {
        urlBtn.classList.remove('hidden');
        urlBtn.onclick = () => window.open(normalizeUrl(scan.content), '_blank');
        _runUrlSafetyWorkflow(scan.content);
    } else {
        urlBtn.classList.add('hidden');
        _safetyRunId++;
    }

    // Stego secrets
    const stegoSection = document.getElementById('result-stego');
    const hasPad = scan.padSecret !== null && scan.padSecret !== '';
    const hasEcc = scan.eccSecret !== null && scan.eccSecret !== '';
    if (hasPad || hasEcc) {
        stegoSection.classList.remove('hidden');
        document.getElementById('result-pad-secret-row').classList.toggle('hidden', !hasPad);
        document.getElementById('result-ecc-secret-row').classList.toggle('hidden', !hasEcc);
        if (hasPad) document.getElementById('result-pad-secret').textContent = scan.padSecret;
        if (hasEcc) document.getElementById('result-ecc-secret').textContent = scan.eccSecret;
    } else {
        stegoSection.classList.add('hidden');
    }

    // Raw QR data: only on live scans (savedId not yet set means freshly decoded)
    renderRawQrData(scan);
}

function renderLocalChecks(scan) {
    const el = document.getElementById('result-local-checks');
    el.innerHTML = '';
    if (scan.contentType !== 'url') {
        el.classList.add('hidden');
        return;
    }

    const level = scan.localRiskLevel || 'safe';
    const labels = scan.localRiskLabels || [];
    const label = document.createElement('span');
    label.className = 'local-checks-label';
    label.textContent = 'Local checks';
    el.appendChild(label);

    if (labels.length === 0) {
        el.appendChild(_riskChip('No obvious flags', 'safe'));
    } else {
        for (const text of labels.slice(0, 4)) {
            el.appendChild(_riskChip(text, _localRiskChipLevel(text, level)));
        }
        if (labels.length > 4) el.appendChild(_riskChip(`+${labels.length - 4}`, 'info'));
    }
    el.classList.remove('hidden');
}

function renderDestLocalChecks(scan) {
    const el = document.getElementById('result-dest-local-checks');
    if (!el) return;
    el.innerHTML = '';

    const finalUrl = scan.finalUrl;
    const labels = scan.finalLocalRiskLabels;
    if (!finalUrl || finalUrl === normalizeUrl(scan.content) || !labels) {
        el.classList.add('hidden');
        return;
    }

    const level = scan.finalLocalRiskLevel || 'safe';
    const heading = document.createElement('span');
    heading.className = 'local-checks-label';
    heading.textContent = 'Destination checks';
    el.appendChild(heading);

    if (labels.length === 0) {
        el.appendChild(_riskChip('No obvious flags', 'safe'));
    } else {
        for (const text of labels.slice(0, 4)) {
            el.appendChild(_riskChip(text, _localRiskChipLevel(text, level)));
        }
        if (labels.length > 4) el.appendChild(_riskChip(`+${labels.length - 4}`, 'info'));
    }
    el.classList.remove('hidden');
}

function _localRiskChipLevel(label, scanLevel) {
    if (scanLevel === 'threat') return label === 'Embedded credentials' ? 'threat' : 'warn';
    if (label === 'Redirect service' || label === 'Long query' || label === 'Sensitive parameter') return 'info';
    if (label === 'HTTP' || label === 'Punycode domain' || label === 'IP address' || label === 'Invalid URL') return 'warn';
    return scanLevel === 'safe' ? 'safe' : 'warn';
}

function _riskChip(text, level) {
    const chip = document.createElement('span');
    chip.className = `risk-chip risk-chip-${level}`;
    chip.textContent = text;
    return chip;
}

// ── Actions ──────────────────────────────────────────────────────────────────

function copyContent() {
    if (!_lastScan) return;
    navigator.clipboard.writeText(_lastScan.content).then(() => {
        showToast('Copied to clipboard');
    }).catch(() => {
        showToast('Copy failed');
    });
}

function copyReport() {
    if (!_lastScan) return;
    const lines = [
        'QR U Aware',
        `Content type: ${_lastScan.contentType}`,
        `Content: ${_lastScan.content}`
    ];
    if (_lastScan.finalUrl || _lastResolution?.finalUrl) {
        lines.push(`Final destination: ${_lastScan.finalUrl || _lastResolution.finalUrl}`);
    }
    if (_lastScan.contentType === 'url') {
        const riskLabels = _lastScan.localRiskLabels || [];
        lines.push(`Local checks: ${riskLabels.length ? riskLabels.join(', ') : 'No obvious flags'}`);
    }
    if (_lastScan.googleVerdict) lines.push(`Google Safe Browsing: ${_lastScan.googleVerdict}`);
    if (_lastScan.domainAgeVerdict) lines.push(`Domain age: ${_lastScan.domainAgeVerdict}`);
    if (_lastScan.vtVerdict) lines.push(`VirusTotal: ${_lastScan.vtVerdict}`);
    lines.push(`Hidden padding data: ${_lastScan.padSecret ? 'Detected' : 'Not detected'}`);
    lines.push(`Hidden ECC data: ${_lastScan.eccSecret ? 'Detected' : 'Not detected'}`);

    navigator.clipboard.writeText(lines.join('\n')).then(() => {
        showToast('Report copied');
    }).catch(() => {
        showToast('Copy failed');
    });
}

function setCollapsibleText(el, text) {
    el.textContent = text;
    el.classList.add('collapsible-text');
    el.classList.toggle('is-collapsed', text.length > COLLAPSE_TEXT_LENGTH);

    const existing = el.nextElementSibling;
    if (existing?.classList.contains('text-toggle')) existing.remove();
    if (text.length <= COLLAPSE_TEXT_LENGTH) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'text-toggle';
    btn.textContent = 'Show More';
    btn.addEventListener('click', () => {
        const collapsed = el.classList.toggle('is-collapsed');
        btn.textContent = collapsed ? 'Show More' : 'Show Less';
    });
    el.insertAdjacentElement('afterend', btn);
}

// ── URL safety + redirect resolution ─────────────────────────────────────────

async function _runUrlSafetyWorkflow(originalUrl) {
    const runId = ++_safetyRunId;
    const normalizedUrl = normalizeUrl(originalUrl);
    const prefs = typeof getNetworkPreferences === 'function' ? getNetworkPreferences() : {
        autoGsb: false,
        autoVt: false,
        autoRedirects: false,
        autoDomainAge: false
    };

    const continueToReputation = async ({ allowDomainAge, allowVirusTotal }) => {
        if (runId !== _safetyRunId) return;
        if (allowDomainAge || prefs.autoDomainAge) {
            await _runDomainAgeStep(runId, normalizedUrl);
        }
        if (runId !== _safetyRunId) return;
        await _runGoogleStep(runId, normalizedUrl, prefs);
        if (runId !== _safetyRunId) return;
        if (allowVirusTotal) await _runVirusTotalStep(runId, normalizedUrl, prefs);
        if (runId === _safetyRunId && _safetyCheckState === 'checking') {
            _safetyCheckState = 'done';
            _updateSimpleVerdict();
        }
    };

    if (prefs.autoRedirects) {
        const resolution = await _runRedirectStep(runId, originalUrl, normalizedUrl);
        await continueToReputation({ allowDomainAge: true, allowVirusTotal: Boolean(resolution) });
        return;
    }

    _showNetworkPrompt({
        title: 'Resolve redirects?',
        text: 'This contacts the scanned URL or link shortener to reveal the destination before reputation checks.',
        actionText: 'Resolve Redirects',
        onAction: async () => {
            _clearNetworkPrompt();
            const resolution = await _runRedirectStep(runId, originalUrl, normalizedUrl);
            await continueToReputation({ allowDomainAge: true, allowVirusTotal: Boolean(resolution) });
        },
        skipText: 'Skip',
        onSkip: async () => {
            _clearNetworkPrompt();
            await continueToReputation({ allowDomainAge: false, allowVirusTotal: false });
        }
    });
}

async function _runRedirectStep(runId, originalUrl, normalizedUrl) {
    const showRedirectLoading = () => {
        if (runId === _safetyRunId) _showRedirectLoading();
    };

    try {
        const resolution = await _resolveUrlChain(originalUrl, showRedirectLoading);
        if (runId !== _safetyRunId) return null;
        _lastResolution = resolution;
        _lastScan.finalUrl = resolution.finalUrl;
        _persistScanPatch({ final_url: resolution.finalUrl });
        if (resolution.finalUrl !== normalizedUrl) {
            const destRisk = analyzeLocalUrlRisks(resolution.finalUrl, { checkHttp: true });
            _lastScan.finalLocalRiskLevel = destRisk.level;
            _lastScan.finalLocalRiskLabels = destRisk.labels;
            renderDestLocalChecks(_lastScan);
        }
        _updateSimpleVerdict();
        const hasDestinations = Object.keys(resolution.destinations || {}).length > 0;
        if (resolution.finalUrl !== normalizedUrl || hasDestinations) {
            _showRedirectChain(originalUrl, resolution);
        } else {
            _hideRedirectSection();
        }
        return resolution;
    } catch (err) {
        if (runId !== _safetyRunId) return null;
        console.warn('Redirect resolution failed:', err);
        _hideRedirectSection();
        showToast('Redirect resolution failed');
        _safetyCheckState = 'unreachable';
        _updateSimpleVerdict();
        return null;
    }
}

async function _runDomainAgeStep(runId, normalizedUrl) {
    const urlToCheck = _lastResolution?.finalUrl || normalizedUrl;
    const target = _lastResolution?.finalUrl && _lastResolution.finalUrl !== normalizedUrl ? 'destination' : 'QR URL';
    const domain = _registrableDomainFromUrl(urlToCheck);
    if (!domain) return;

    _showDomainAgeChecking(domain, target);
    try {
        const result = await _lookupDomainAge(domain);
        if (runId !== _safetyRunId) return;
        _renderDomainAgeResult(result);
        _rememberDomainAgeResult(result);
    } catch (err) {
        if (runId !== _safetyRunId) return;
        console.warn('Domain age lookup failed:', err);
        const result = {
            domain,
            registeredAt: null,
            verdict: 'Domain age unavailable',
            level: 'muted',
            error: err.message
        };
        _renderDomainAgeResult(result);
        _rememberDomainAgeResult(result);
    }
}

function _refreshStoredDomainAge(scan) {
    if (!scan.domainAgeRegisteredAt || !scan.domainAgeDomain) return;
    const refreshed = _classifyDomainAge(scan.domainAgeDomain, scan.domainAgeRegisteredAt);
    if (refreshed.verdict === scan.domainAgeVerdict && refreshed.level === scan.domainAgeLevel) return;

    scan.domainAgeVerdict = refreshed.verdict;
    scan.domainAgeLevel = refreshed.level;
    _persistScanPatch({
        domain_age_verdict: refreshed.verdict,
        domain_age_level: refreshed.level
    });
}

function _showDomainAgeChecking(domain, target) {
    const box = document.getElementById('result-domain-age');
    const status = document.getElementById('result-domain-age-status');
    if (!box || !status) return;
    status.className = 'domain-age-status domain-age-muted';
    status.textContent = `Checking ${target.toLowerCase()} domain ${domain}...`;
    box.classList.remove('hidden');
}

function _hideDomainAge() {
    const box = document.getElementById('result-domain-age');
    const status = document.getElementById('result-domain-age-status');
    if (status) {
        status.textContent = '';
        status.className = 'domain-age-status';
    }
    box?.classList.add('hidden');
}

function _renderDomainAgeResult(result) {
    const box = document.getElementById('result-domain-age');
    const status = document.getElementById('result-domain-age-status');
    if (!box || !status) return;
    const cls = result.level === 'danger' ? 'domain-age-danger'
        : result.level === 'warn' ? 'domain-age-warn'
        : 'domain-age-muted';
    status.className = `domain-age-status ${cls}`;
    status.textContent = result.domain ? `${result.domain}: ${result.verdict}` : result.verdict;
    box.classList.remove('hidden');
}

function _rememberDomainAgeResult(result) {
    _lastScan.domainAgeDomain = result.domain || null;
    _lastScan.domainAgeRegisteredAt = result.registeredAt || null;
    _lastScan.domainAgeVerdict = result.verdict || null;
    _lastScan.domainAgeLevel = result.level || null;
    _persistScanPatch({
        domain_age_domain: _lastScan.domainAgeDomain,
        domain_age_registered_at: _lastScan.domainAgeRegisteredAt,
        domain_age_verdict: _lastScan.domainAgeVerdict,
        domain_age_level: _lastScan.domainAgeLevel
    });
    _updateSimpleVerdict();
}

async function _lookupDomainAge(domain) {
    const cached = _readDomainAgeCache(domain);
    if (cached) return { ...cached, fromCache: true };

    try {
        const rdap = await _fetchDomainRdap(domain);
        const registeredAt = _extractRdapRegistrationDate(rdap);
        const result = _classifyDomainAge(domain, registeredAt);
        _writeDomainAgeCache(domain, result, _DOMAIN_AGE_SUCCESS_TTL_MS);
        return result;
    } catch (err) {
        const result = {
            domain,
            registeredAt: null,
            verdict: 'Domain age unavailable',
            level: 'muted',
            error: err.message
        };
        _writeDomainAgeCache(domain, result, _DOMAIN_AGE_ERROR_TTL_MS);
        throw err;
    }
}

async function _fetchDomainRdap(domain) {
    const baseUrls = await _rdapBaseUrlsForDomain(domain);
    let lastErr = null;
    for (const baseUrl of baseUrls) {
        try {
            const url = new URL(`domain/${encodeURIComponent(domain)}`, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
            const resp = await fetch(url.href, { headers: { Accept: 'application/rdap+json, application/json' } });
            if (!resp.ok) throw new Error(`RDAP HTTP ${resp.status}`);
            return await resp.json();
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error('No RDAP server for domain');
}

async function _rdapBaseUrlsForDomain(domain) {
    const tld = domain.split('.').pop().toLowerCase();
    const bootstrap = await _getRdapBootstrap();
    const services = bootstrap?.services || [];
    for (const service of services) {
        const tlds = service?.[0] || [];
        const urls = service?.[1] || [];
        if (tlds.map(String).some(item => item.toLowerCase() === tld) && urls.length) return urls;
    }
    throw new Error(`No RDAP server for .${tld}`);
}

async function _getRdapBootstrap() {
    const cached = _readJsonCache(_RDAP_BOOTSTRAP_CACHE_KEY);
    if (cached) return cached;
    const resp = await fetch('https://data.iana.org/rdap/dns.json', { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`RDAP bootstrap HTTP ${resp.status}`);
    const data = await resp.json();
    _writeJsonCache(_RDAP_BOOTSTRAP_CACHE_KEY, data, _DOMAIN_AGE_SUCCESS_TTL_MS);
    return data;
}

function _extractRdapRegistrationDate(rdap) {
    const events = Array.isArray(rdap?.events) ? rdap.events : [];
    const registration = events.find(event => /^(registration|created|creation)$/i.test(event.eventAction || ''));
    const date = registration?.eventDate;
    if (!date || Number.isNaN(Date.parse(date))) return null;
    return new Date(date).toISOString();
}

function _classifyDomainAge(domain, registeredAt) {
    if (!registeredAt) {
        return {
            domain,
            registeredAt: null,
            verdict: 'Domain registration date unavailable',
            level: 'muted'
        };
    }

    const days = Math.max(0, Math.floor((Date.now() - Date.parse(registeredAt)) / 86400000));
    const age = _formatDomainAge(days);
    if (days < 7) {
        return { domain, registeredAt, verdict: `Newly registered domain (${age})`, level: 'danger' };
    }
    if (days < 30) {
        return { domain, registeredAt, verdict: `Recently registered domain (${age})`, level: 'warn' };
    }
    if (days < 180) {
        return { domain, registeredAt, verdict: `Young domain (${age})`, level: 'warn' };
    }
    return { domain, registeredAt, verdict: `Registered ${age}`, level: 'muted' };
}

function _formatDomainAge(days) {
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    if (days < 60) return `${days} days ago`;
    const months = Math.floor(days / 30);
    if (months < 24) return `${months} month${months === 1 ? '' : 's'} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? '' : 's'} ago`;
}

function _registrableDomainFromUrl(value) {
    let host;
    try {
        host = new URL(normalizeUrl(value)).hostname.toLowerCase().replace(/\.$/, '');
    } catch (_) {
        return '';
    }
    host = host.replace(/^www\./, '');
    if (!host || host === 'localhost' || host.includes(':') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return '';

    const labels = host.split('.').filter(Boolean);
    if (labels.length <= 2) return host;
    const tld = labels[labels.length - 1];
    const sld = labels[labels.length - 2];
    const needsThirdLevel = tld.length === 2 && _COMMON_SECOND_LEVEL_TLDS.has(sld) && labels.length >= 3;
    return needsThirdLevel ? labels.slice(-3).join('.') : labels.slice(-2).join('.');
}

function _readDomainAgeCache(domain) {
    return _readJsonCache(_DOMAIN_AGE_CACHE_PREFIX + domain);
}

function _writeDomainAgeCache(domain, value, ttlMs) {
    _writeJsonCache(_DOMAIN_AGE_CACHE_PREFIX + domain, value, ttlMs);
}

function _readJsonCache(key) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed.expiresAt || Date.now() > parsed.expiresAt) {
            localStorage.removeItem(key);
            return null;
        }
        return parsed.value;
    } catch (_) {
        return null;
    }
}

function _writeJsonCache(key, value, ttlMs) {
    try {
        localStorage.setItem(key, JSON.stringify({ value, expiresAt: Date.now() + ttlMs }));
    } catch (_) {}
}

async function _runGoogleStep(runId, normalizedUrl, prefs) {
    const apiKey = await getGsbApiKey();
    if (runId !== _safetyRunId) return;
    if (!apiKey) {
        _renderSafetyStatus([{ url: normalizedUrl, threats: null, missingKey: true }]);
        return;
    }

    const runCheck = async () => {
        _clearNetworkPrompt();
        await _checkGoogleUrls(runId, normalizedUrl);
    };

    if (prefs.autoGsb) {
        await runCheck();
        return;
    }

    await new Promise(resolve => {
        const hasResolvedDestination = Boolean(_lastResolution?.finalUrl && _lastResolution.finalUrl !== normalizedUrl);
        _showNetworkPrompt({
            title: 'Check with Google Safe Browsing?',
            text: hasResolvedDestination
                ? 'This sends the resolved destination URL to Google Safe Browsing.'
                : 'This sends the QR URL to Google Safe Browsing.',
            actionText: 'Check Google',
            onAction: async () => {
                await runCheck();
                resolve();
            },
            skipText: 'Skip',
            onSkip: () => {
                _clearNetworkPrompt();
                resolve();
            },
            target: hasResolvedDestination ? 'resolved' : 'content'
        });
    });
}

async function _checkGoogleUrls(runId, normalizedUrl) {
    const checkUrl = _lastResolution?.finalUrl || normalizedUrl;
    const label = checkUrl === normalizedUrl ? 'QR URL' : 'Destination';
    const target = checkUrl === normalizedUrl ? 'content' : 'resolved';
    const checks = [];

    _setSafetyChecking(`Google Safe Browsing: checking ${label.toLowerCase()}…`, target);
    try {
        const check = await _checkSafeBrowsing(checkUrl);
        if (runId !== _safetyRunId) return;
        checks.push(check);
        _renderSafetyStatus(checks, target);
    } catch (err) {
        if (runId !== _safetyRunId) return;
        console.warn(`Google Safe Browsing ${label.toLowerCase()} check failed:`, err);
        checks.push({ url: checkUrl, threats: null, error: err });
        _renderSafetyStatus(checks, target);
    }

    _renderSafetyDetails([{ label, check: checks[0] }], target);
}

async function _runVirusTotalStep(runId, normalizedUrl, prefs) {
    const apiKey = await getVtApiKey();
    if (runId !== _safetyRunId || !apiKey) return;
    if (!_lastResolution?.finalUrl) return;

    const url = _lastResolution.finalUrl;
    const runScan = async () => {
        _clearNetworkPrompt();
        await _scanWithVirusTotal(runId, url, apiKey);
    };

    if (prefs.autoVt) {
        await runScan();
        return;
    }

    _showNetworkPrompt({
        title: 'Scan with VirusTotal?',
        text: 'This submits the final destination URL to VirusTotal. VirusTotal may share submitted URLs and analysis results with security partners.',
        actionText: 'Scan VirusTotal',
        onAction: runScan,
        skipText: 'Skip',
        onSkip: _clearNetworkPrompt,
        target: url !== normalizedUrl ? 'resolved' : 'content'
    });
}

function _showNetworkPrompt({ title, text, actionText, onAction, skipText = '', onSkip = null, target = 'content' }) {
    const prompt = document.getElementById('result-network-prompt');
    const action = document.getElementById('result-network-prompt-btn');
    const skip = document.getElementById('result-network-prompt-skip');
    const host = target === 'resolved'
        ? document.getElementById('result-resolved-vt-prompt-host')
        : document.getElementById('result-network-prompt-home');
    if (host && prompt.parentElement !== host) host.appendChild(prompt);
    document.getElementById('result-network-prompt-title').textContent = title;
    document.getElementById('result-network-prompt-text').textContent = text;
    action.textContent = actionText;
    action.disabled = false;
    action.onclick = async () => {
        action.disabled = true;
        skip.disabled = true;
        try { await onAction(); }
        finally {
            action.disabled = false;
            skip.disabled = false;
        }
    };
    if (skipText && onSkip) {
        skip.textContent = skipText;
        skip.onclick = onSkip;
        skip.classList.remove('hidden');
    } else {
        skip.classList.add('hidden');
        skip.onclick = null;
    }
    prompt.classList.remove('hidden');
}

function _clearNetworkPrompt() {
    const prompt = document.getElementById('result-network-prompt');
    if (!prompt) return;
    prompt.classList.add('hidden');
    document.getElementById('result-network-prompt-btn').onclick = null;
    document.getElementById('result-network-prompt-skip').onclick = null;
    const home = document.getElementById('result-network-prompt-home');
    if (home && prompt.parentElement !== home) home.appendChild(prompt);
}

async function _scanWithVirusTotal(runId, url, apiKey) {
    _showVirusTotalStatus('Submitting URL to VirusTotal…');
    try {
        const analysis = await _submitVirusTotalUrl(url, apiKey);
        if (runId !== _safetyRunId) return;

        const completed = await _pollVirusTotalAnalysis(analysis.id, apiKey);
        if (runId !== _safetyRunId) return;

        const stats = completed?.attributes?.stats || {};
        _renderVirusTotalResult(url, stats);
    } catch (err) {
        if (runId !== _safetyRunId) return;
        console.warn('VirusTotal scan failed:', err);
        _showVirusTotalStatus('VirusTotal scan failed: ' + err.message);
    }
}

async function _submitVirusTotalUrl(url, apiKey) {
    const resp = await fetch('https://www.virustotal.com/api/v3/urls', {
        method: 'POST',
        headers: {
            'x-apikey': apiKey,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ url }).toString()
    });
    if (!resp.ok) throw new Error(_httpStatusText(resp.status));
    const data = await resp.json();
    if (!data?.data?.id) throw new Error('Unexpected VirusTotal response');
    return data.data;
}

async function _pollVirusTotalAnalysis(analysisId, apiKey) {
    for (let i = 0; i < 10; i++) {
        const resp = await fetch(`https://www.virustotal.com/api/v3/analyses/${encodeURIComponent(analysisId)}`, {
            headers: { 'x-apikey': apiKey }
        });
        if (!resp.ok) throw new Error(_httpStatusText(resp.status));
        const data = await resp.json();
        const attrs = data?.data?.attributes;
        if (attrs?.status === 'completed') return data.data;
        await _delay(1800);
    }
    throw new Error('Timed out waiting for VirusTotal analysis');
}

function _renderVirusTotalResult(url, stats) {
    document.getElementById('result-vt-section').classList.remove('hidden');
    document.getElementById('result-vt-status').textContent = _virusTotalSummary(stats);
    document.getElementById('result-vt-stats').classList.remove('hidden');
    document.getElementById('result-vt-malicious').textContent = stats.malicious || 0;
    document.getElementById('result-vt-suspicious').textContent = stats.suspicious || 0;
    document.getElementById('result-vt-harmless').textContent = stats.harmless || 0;
    document.getElementById('result-vt-undetected').textContent = stats.undetected || 0;
    const verdict = _virusTotalVerdict(stats);
    _lastScan.vtVerdict = verdict;
    _persistScanPatch({ vt_verdict: verdict });
    _updateSimpleVerdict();

    const link = document.getElementById('result-vt-link');
    link.href = `https://www.virustotal.com/gui/url/${_virusTotalUrlId(url)}`;
    link.classList.remove('hidden');
}

function _showVirusTotalStatus(text) {
    document.getElementById('result-vt-section').classList.remove('hidden');
    document.getElementById('result-vt-status').textContent = text;
    document.getElementById('result-vt-stats').classList.add('hidden');
    document.getElementById('result-vt-link').classList.add('hidden');
}

function _hideVirusTotalResult() {
    const section = document.getElementById('result-vt-section');
    if (!section) return;
    section.classList.add('hidden');
    document.getElementById('result-vt-status').textContent = '';
    document.getElementById('result-vt-stats').classList.add('hidden');
    document.getElementById('result-vt-link').classList.add('hidden');
}

function _virusTotalSummary(stats) {
    const malicious = stats.malicious || 0;
    const suspicious = stats.suspicious || 0;
    if (malicious > 0) return `VirusTotal flagged this URL as malicious by ${malicious} engine${malicious === 1 ? '' : 's'}.`;
    if (suspicious > 0) return `VirusTotal marked this URL as suspicious by ${suspicious} engine${suspicious === 1 ? '' : 's'}.`;
    return 'VirusTotal analysis completed with no malicious detections.';
}

function _virusTotalVerdict(stats) {
    const malicious = stats.malicious || 0;
    const suspicious = stats.suspicious || 0;
    if (malicious > 0) return `Threat (${malicious} malicious)`;
    if (suspicious > 0) return `Warning (${suspicious} suspicious)`;
    return 'No threats detected';
}

function _virusTotalUrlId(url) {
    const bytes = new TextEncoder().encode(url);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function _httpStatusText(status) {
    if (status === 401 || status === 403) return 'API key was rejected';
    if (status === 429) return 'rate limit exceeded';
    return `HTTP ${status}`;
}

function _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Tries service-specific resolvers first, then HTTP redirect following, then smart link probing.
// Always returns { finalUrl, platform, destinations }.
async function _resolveUrlChain(url, onRedirectDetected = () => {}) {
    const serviceResult = await _resolveServiceSpecific(url);
    if (serviceResult) {
        onRedirectDetected();
        return serviceResult;
    }

    const normalizedUrl = normalizeUrl(url);

    // Known smart link host: probe with platform UAs before standard redirect following
    // to avoid the device's native UA biasing the redirect to one platform.
    if (_isSmartLink(normalizedUrl) && isNativeCapacitor()) {
        onRedirectDetected();
        const destinations = await _resolveSmartLinkDestinations(normalizedUrl);
        return { finalUrl: normalizedUrl, platform: _getSmartLinkPlatform(normalizedUrl), destinations };
    }

    const finalUrl = await followRedirects(url, onRedirectDetected);

    // A redirect may have landed on a smart link.
    if (_isSmartLink(finalUrl) && isNativeCapacitor()) {
        onRedirectDetected();
        const destinations = await _resolveSmartLinkDestinations(finalUrl);
        return { finalUrl, platform: _getSmartLinkPlatform(finalUrl), destinations };
    }

    const destinations = isNativeCapacitor()
        ? await _resolveLandingPageDestinations(finalUrl)
        : {};
    return { finalUrl, platform: null, destinations };
}

// Dispatches to per-service API resolvers for known SPA-based URL shorteners.
async function _resolveServiceSpecific(url) {
    const scannedPageDest = await _resolveScannedPage(url);
    if (scannedPageDest) return { finalUrl: scannedPageDest, platform: null, destinations: {} };

    const dest = await _resolveViewPage(url);
    if (!dest) return null;
    return { finalUrl: dest, platform: null, destinations: {} };
}

// scanned.page is a React SPA from Online QR Generator. Its page returns HTTP
// 200 for QR URLs, while this public API exposes the actual target URL.
async function _resolveScannedPage(url) {
    const match = url.match(/^https?:\/\/(?:www\.)?scanned\.page\/(?:[^/?#]+\/)?([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i);
    if (!match) return null;
    try {
        const resp = await fetch(`https://scanned.page/api/qr-code?uId=${encodeURIComponent(match[1])}`);
        if (!resp.ok) return null;
        const json = await resp.json();
        if (json?.status && json.status !== 'ACTIVE') return null;
        if (json?.data?.requires_password) {
            throw new Error('QR code is password-protected');
        }
        const dest = json?.data?.url;
        if (!dest) return null;
        return dest.replace(/^http:\/\//i, 'https://');
    } catch (err) {
        if (err.message.includes('password')) throw err;
        return null;
    }
}

// view.page is a React SPA used by Albertsons/Tom Thumb and others.
// It returns HTTP 200 with a JS bundle — standard redirect following misses it.
// Their public API returns the destination URL directly and is CORS-open.
async function _resolveViewPage(url) {
    const match = url.match(/^https?:\/\/view\.page\/([A-Za-z0-9_-]+)/i);
    if (!match) return null;
    try {
        const resp = await fetch(`https://view.page/api/qr-code?uId=${match[1]}`);
        if (!resp.ok) return null;
        const json = await resp.json();
        if (json?.data?.requires_password) {
            throw new Error('QR code is password-protected');
        }
        const dest = json?.data?.url;
        if (!dest) return null;
        return dest.replace(/^http:\/\//i, 'https://');
    } catch (err) {
        if (err.message.includes('password')) throw err;
        return null;
    }
}

function _isSmartLink(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        return _isSmartLinkHost(host);
    } catch (_) { return false; }
}

function _isSmartLinkHost(host) {
    const normalized = String(host || '').toLowerCase().replace(/^www\./, '');
    return _SMART_LINK_HOSTS.has(normalized) || normalized.endsWith('.onelink.me');
}

function _getSmartLinkPlatform(url) {
    try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (host === 'onelink.to' || host === 'go.onelink.me' || host.endsWith('.onelink.me')) return 'AppsFlyer';
        if (host === 'app.link'   || host === 'bnc.lt')        return 'Branch';
        if (host === 'page.link')                               return 'Firebase';
        if (host === 'adj.st'     || host === 'a.adj.st')      return 'Adjust';
    } catch (_) {}
    return 'Smart Link';
}

function _isAppStoreUrl(url) { return /apps\.apple\.com/i.test(url); }
function _isPlayStoreUrl(url) { return /play\.google\.com\/store/i.test(url); }

// Makes native HTTP GET requests following redirects with a custom User-Agent.
// Returns { url, html } on success, or null if native HTTP is unavailable.
async function _resolveWithUA(url, ua) {
    const http = getCapacitorHttp();
    if (!http || !isNativeCapacitor()) return null;

    let currentUrl = url;
    const visited = new Set();
    for (let i = 0; i < 10; i++) {
        if (visited.has(currentUrl)) return { url: currentUrl, html: '' };
        visited.add(currentUrl);
        try {
            const resp = await http.request({
                url: currentUrl,
                method: 'GET',
                disableRedirects: true,
                responseType: 'text',
                headers: { 'User-Agent': ua },
                connectTimeout: 8000,
                readTimeout: 8000,
            });
            if (isRedirectStatus(resp.status)) {
                const loc = getHeader(resp.headers, 'location');
                if (!loc) return { url: currentUrl, html: '' };
                currentUrl = new URL(loc.replace(/^http:\/\//i, 'https://'), currentUrl).href;
            } else {
                return { url: resp.url || currentUrl, html: typeof resp.data === 'string' ? resp.data : '' };
            }
        } catch (_) { return null; }
    }
    return { url: currentUrl, html: '' };
}

// Parses App Links meta tags and app store anchor hrefs from a landing page.
// Returns a partial { ios, android } object with store URLs.
function _extractAppLinksFromPage(html) {
    if (!html) return {};
    const result = {};
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const alIosId  = doc.querySelector('meta[property="al:ios:app_store_id"]')?.getAttribute('content');
        const alDroid  = doc.querySelector('meta[property="al:android:package"]')?.getAttribute('content');
        if (alIosId) result.ios     = `https://apps.apple.com/app/id${alIosId}`;
        if (alDroid)  result.android = `https://play.google.com/store/apps/details?id=${alDroid}`;

        if (!result.ios) {
            const itunes = doc.querySelector('meta[name="apple-itunes-app"]')?.getAttribute('content');
            const m = itunes?.match(/app-id=(\d+)/i);
            if (m) result.ios = `https://apps.apple.com/app/id${m[1]}`;
        }
        if (!result.ios) {
            const a = doc.querySelector('a[href*="apps.apple.com"]')?.getAttribute('href');
            if (a) result.ios = a;
        }
        if (!result.android) {
            const a = doc.querySelector('a[href*="play.google.com/store"]')?.getAttribute('href');
            if (a) result.android = a;
        }
    } catch (_) {}
    return result;
}

// Probes a smart link URL with iOS, Android, and desktop User-Agents in parallel.
// Collects platform destinations from server-side redirects and App Links meta tags.
async function _resolveSmartLinkDestinations(url) {
    const destinations = {};
    const [iosRes, androidRes, desktopRes] = await Promise.all([
        _resolveWithUA(url, _UA_IOS).catch(() => null),
        _resolveWithUA(url, _UA_ANDROID).catch(() => null),
        _resolveWithUA(url, _UA_DESKTOP).catch(() => null),
    ]);

    if (iosRes     && _isAppStoreUrl(iosRes.url))          destinations.ios     = iosRes.url;
    if (androidRes && _isPlayStoreUrl(androidRes.url))     destinations.android = androidRes.url;
    if (desktopRes && desktopRes.url !== url)              destinations.web     = desktopRes.url;

    for (const res of [iosRes, androidRes, desktopRes]) {
        if (!res?.html) continue;
        const appLinks = _extractAppLinksFromPage(res.html);
        if (appLinks.ios     && !destinations.ios)     destinations.ios     = appLinks.ios;
        if (appLinks.android && !destinations.android) destinations.android = appLinks.android;
        break;
    }
    return destinations;
}

// Some redirect services land on a normal web page which advertises app store
// links instead of redirecting by platform. Probe that final page once and add
// any store links to the visible redirect chain.
async function _resolveLandingPageDestinations(url) {
    const response = await _resolveWithUA(url, _UA_DESKTOP).catch(() => null);
    if (!response?.html) return {};
    return _extractAppLinksFromPage(response.html);
}

function _showRedirectChain(originalUrl, resolution) {
    const { finalUrl, platform, destinations } = resolution;
    document.getElementById('result-redirect-loading').classList.add('hidden');
    document.getElementById('result-redirect-chain').classList.remove('hidden');
    const hops = _buildRedirectHops(originalUrl, finalUrl, destinations);
    _renderRedirectHops(hops);
    const openUrl = _preferredDestinationUrl(finalUrl, destinations);
    document.getElementById('result-open-resolved').onclick = () => window.open(openUrl, '_blank');

    const platformBadge = document.getElementById('result-platform-badge');
    if (platform) {
        platformBadge.textContent = platform;
        platformBadge.classList.remove('hidden');
    } else {
        platformBadge.classList.add('hidden');
    }

    document.getElementById('result-resolved-section').classList.remove('hidden');
}

function _buildRedirectHops(originalUrl, finalUrl, destinations = {}) {
    const hops = [{ label: 'QR URL', url: originalUrl, original: true }];
    if (finalUrl && finalUrl !== originalUrl) {
        hops.push({ label: _isSmartLink(finalUrl) ? 'Smart Link' : 'Destination', url: finalUrl });
    } else if (finalUrl && Object.keys(destinations).length === 0) {
        hops.push({ label: 'Destination', url: finalUrl });
    }

    for (const { key, label } of [
        { key: 'ios', label: 'iOS App Store' },
        { key: 'android', label: 'Android Play Store' },
        { key: 'web', label: 'Web Destination' }
    ]) {
        const url = destinations[key];
        if (url && !hops.some(hop => hop.url === url)) hops.push({ label, url, open: true });
    }
    return hops;
}

function _renderRedirectHops(hops) {
    const container = document.getElementById('result-redirect-hops');
    const promptHost = document.getElementById('result-resolved-vt-prompt-host');
    container.innerHTML = '';
    hops.forEach((hop, index) => {
        if (index > 0) {
            const arrow = document.createElement('div');
            arrow.className = 'redirect-arrow';
            arrow.innerHTML = '&#x2193;';
            container.appendChild(arrow);
        }

        const row = document.createElement('div');
        row.className = 'redirect-hop';
        const label = document.createElement('span');
        label.className = 'redirect-hop-label';
        label.textContent = hop.label;
        const url = document.createElement('span');
        url.className = `redirect-hop-url${hop.original ? ' hop-original' : ''}`;
        setCollapsibleText(url, hop.url);
        row.appendChild(label);
        row.appendChild(url);

        if (hop.open) {
            const open = document.createElement('button');
            open.className = 'platform-dest-open btn btn-sm btn-secondary';
            open.textContent = 'Open';
            open.addEventListener('click', () => window.open(hop.url, '_blank'));
            row.appendChild(open);
        }
        container.appendChild(row);
    });
    if (promptHost) container.appendChild(promptHost);
}

function _preferredDestinationUrl(finalUrl, destinations = {}) {
    const platform = window.Capacitor?.getPlatform?.();
    if (platform === 'ios' && destinations.ios) return destinations.ios;
    if (platform === 'android' && destinations.android) return destinations.android;
    return destinations.web || finalUrl;
}

function _showRedirectLoading() {
    document.getElementById('result-resolved-section').classList.remove('hidden');
    document.getElementById('result-redirect-loading').classList.remove('hidden');
    document.getElementById('result-redirect-chain').classList.add('hidden');
    document.getElementById('result-safety-details').classList.add('hidden');
    document.getElementById('result-safety-detail-list').innerHTML = '';
    _setSafetyDetailsTitle('Google Safe Browsing', '');
    document.getElementById('result-platform-badge').classList.add('hidden');
    const hops = document.getElementById('result-redirect-hops');
    if (hops) {
        const promptHost = document.getElementById('result-resolved-vt-prompt-host');
        hops.innerHTML = '';
        if (promptHost) hops.appendChild(promptHost);
    }
}

function _hideRedirectSection() {
    document.getElementById('result-redirect-loading').classList.add('hidden');
    document.getElementById('result-redirect-chain').classList.add('hidden');
    document.getElementById('result-resolved-section').classList.add('hidden');
}

function _setSafetyChecking(text, target = _safetyDetailsTarget) {
    _ensureSafetyDetailsVisible(target);
    document.getElementById('result-safety-detail-list').innerHTML = '';
    _setSafetyDetailsTitle(text, 'safety-detail-nokey');
}

function _ensureSafetyDetailsVisible(target = _safetyDetailsTarget) {
    _safetyDetailsTarget = target;
    _moveSafetyDetails(target);
    if (target === 'resolved') {
        document.getElementById('result-resolved-section').classList.remove('hidden');
    }
    document.getElementById('result-redirect-loading').classList.add('hidden');
    document.getElementById('result-safety-details').classList.remove('hidden');
}

function _moveSafetyDetails(target) {
    const details = document.getElementById('result-safety-details');
    const host = target === 'resolved'
        ? document.getElementById('result-safety-details-redirect-host')
        : document.getElementById('result-safety-details-home');
    if (details && host && details.parentElement !== host) host.appendChild(details);
}

async function _checkSafeBrowsing(url) {
    const apiKey = await getGsbApiKey();
    if (!apiKey) {
        return { url, threats: null, missingKey: true };
    }
    return { url, threats: await _callSafeBrowsing(url, apiKey) };
}

function _renderSafetyStatus(checks, target = _safetyDetailsTarget) {
    _ensureSafetyDetailsVisible(target);
    document.getElementById('result-safety-detail-list').innerHTML = '';
    let verdict = '';

    if (!Array.isArray(checks) || checks.length === 0) {
        verdict = 'Check failed';
        _setSafetyDetailsTitle('Google Safe Browsing: check failed', 'safety-detail-warn');
        _rememberGoogleVerdict(verdict);
        return;
    }

    if (checks.some(c => c.missingKey)) {
        verdict = 'No key configured';
        _setSafetyDetailsTitle('Google Safe Browsing: no key configured', 'safety-detail-nokey');
        _rememberGoogleVerdict(verdict);
        return;
    }

    const threatMatches = checks.flatMap(c => c.threats || []);
    if (threatMatches.length > 0) {
        const types = [...new Set(threatMatches.map(t => _friendlyThreatType(t.threatType)))].join(', ');
        verdict = types;
        _setSafetyDetailsTitle('Google Safe Browsing: ' + types, 'safety-detail-threat');
        _rememberGoogleVerdict(verdict);
        return;
    }

    const failedCount = checks.filter(c => c.error || !Array.isArray(c.threats)).length;
    const cleanCount = checks.filter(c => Array.isArray(c.threats) && c.threats.length === 0).length;
    if (failedCount > 0 && cleanCount > 0) {
        verdict = 'Partially checked';
        _setSafetyDetailsTitle('Google Safe Browsing: partially checked', 'safety-detail-warn');
        _rememberGoogleVerdict(verdict);
        return;
    }
    if (failedCount > 0) {
        verdict = 'Check failed';
        _setSafetyDetailsTitle('Google Safe Browsing: check failed', 'safety-detail-warn');
        _rememberGoogleVerdict(verdict);
        return;
    }

    verdict = 'Not known malicious';
    _setSafetyDetailsTitle('Google Safe Browsing: not known malicious', 'safety-detail-safe');
    _rememberGoogleVerdict(verdict);
}

function _rememberGoogleVerdict(verdict) {
    _lastScan.googleVerdict = verdict;
    _persistScanPatch({ google_verdict: verdict });
    _updateSimpleVerdict();
}

function _renderSafetyDetails(items, target = _safetyDetailsTarget) {
    _ensureSafetyDetailsVisible(target);
    const details = document.getElementById('result-safety-details');
    const list = document.getElementById('result-safety-detail-list');
    list.innerHTML = '';
    details.classList.toggle('hidden', !items.some(item => item.check));
}

function _setSafetyDetailsTitle(text, className) {
    const title = document.getElementById('result-safety-details-title');
    if (!title) return;
    title.className = 'safety-details-title';
    if (className) title.classList.add(className);
    title.textContent = text;
}

async function _callSafeBrowsing(url, apiKey) {
    const body = {
        client: { clientId: 'qr-stego-scanner', clientVersion: '1.0' },
        threatInfo: {
            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'],
            platformTypes: ['ANY_PLATFORM'],
            threatEntryTypes: ['URL'],
            threatEntries: [{ url }]
        }
    };
    const resp = await fetch(
        `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
        { method: 'POST', headers: _safeBrowsingHeaders(), body: JSON.stringify(body) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.matches || [];
}

function _safeBrowsingHeaders() {
    const cfg = window.QR_STEGO_CONFIG || {};
    const headers = { 'Content-Type': 'application/json' };

    if (cfg.iosBundleId) {
        headers['X-Ios-Bundle-Identifier'] = cfg.iosBundleId;
    }

    if (cfg.androidPackageName && cfg.androidCertSha1) {
        headers['X-Android-Package'] = cfg.androidPackageName;
        headers['X-Android-Cert'] = String(cfg.androidCertSha1).replace(/:/g, '').toUpperCase();
    }

    return headers;
}

function _friendlyThreatType(type) {
    const map = {
        MALWARE: 'Malware',
        SOCIAL_ENGINEERING: 'Phishing',
        UNWANTED_SOFTWARE: 'Unwanted software',
        POTENTIALLY_HARMFUL_APPLICATION: 'Harmful app'
    };
    return map[type] || type;
}

async function followRedirects(url, onRedirectDetected = () => {}) {
    const normalizedUrl = normalizeUrl(url);
    const isOriginalHttp = /^http:\/\//i.test(url);

    // Try HTTPS (normalized) via native HTTP. If that throws — e.g. the
    // shortener domain has no SSL certificate and only speaks plain HTTP —
    // retry with the original http:// URL so the redirect chain can still
    // be followed to its HTTPS destination.
    try {
        const nativeFinalUrl = await followRedirectsWithNativeHttp(normalizedUrl, onRedirectDetected);
        if (nativeFinalUrl) return nativeFinalUrl;
    } catch (_) {
        if (isOriginalHttp) {
            try {
                const nativeFinalUrl = await followRedirectsWithNativeHttp(url, onRedirectDetected);
                if (nativeFinalUrl) return nativeFinalUrl;
            } catch (_) {}
        }
    }

    // Browser fallback. For HTTP-origin URLs also try the original scheme in
    // case the shortener domain has no HTTPS certificate.
    const candidates = isOriginalHttp ? [normalizedUrl, url] : [normalizedUrl];
    for (const candidate of candidates) {
        for (const method of ['HEAD', 'GET']) {
            try {
                const resp = await fetch(candidate, { method, redirect: 'follow' });
                const dest = resp.url;
                if (dest) return dest;
            } catch (_) {}
        }
    }
    throw new Error('Network request failed — check connection and try again');
}

async function followRedirectsWithNativeHttp(url, onRedirectDetected = () => {}) {
    const http = getCapacitorHttp();
    if (!http || !isNativeCapacitor()) return null;
    const userAgent = getNativeBrowserUserAgent();

    let currentUrl = url;
    const visited = new Set();
    for (let i = 0; i < 20; i++) {
        if (visited.has(currentUrl)) {
            throw new Error('Redirect loop detected');
        }
        visited.add(currentUrl);

        const response = await nativeRedirectRequest(http, currentUrl, userAgent);
        if (!isRedirectStatus(response.status)) {
            const htmlRedirect = extractHtmlRedirect(response.data, response.url || currentUrl);
            if (htmlRedirect) {
                onRedirectDetected();
                currentUrl = htmlRedirect;
                continue;
            }
            return response.url || currentUrl;
        }

        const rawLocation = getHeader(response.headers, 'location');
        if (!rawLocation) {
            return response.url || currentUrl;
        }
        onRedirectDetected();
        // Upgrade HTTP redirect locations — same ATS/security reason as normalizeUrl.
        const location = rawLocation.replace(/^http:\/\//i, 'https://');
        currentUrl = new URL(location, currentUrl).href;
    }
    throw new Error('Too many redirects');
}

async function nativeRedirectRequest(http, url, userAgent) {
    return http.request({
        url,
        method: 'GET',
        disableRedirects: true,
        responseType: 'text',
        headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Upgrade-Insecure-Requests': '1',
        },
        connectTimeout: 10000,
        readTimeout: 10000
    });
}

function getNativeBrowserUserAgent() {
    const platform = window.Capacitor?.getPlatform?.();
    if (platform === 'ios') return _UA_IOS;
    if (platform === 'android') return _UA_ANDROID;
    return _UA_DESKTOP;
}

function getCapacitorHttp() {
    return window.Capacitor?.Plugins?.CapacitorHttp || window.CapacitorHttp || null;
}

function isNativeCapacitor() {
    return Boolean(window.Capacitor?.isNativePlatform?.());
}

function isRedirectStatus(status) {
    return status >= 300 && status < 400;
}

function getHeader(headers, name) {
    if (!headers) return '';
    const match = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
    return match ? headers[match] : '';
}

function normalizeUrl(url) {
    const trimmed = String(url || '').trim();
    if (/^https:\/\//i.test(trimmed)) return trimmed;
    // Upgrade http:// → https:// for security posture; we retry with the
    // original http:// scheme in followRedirects if the HTTPS attempt fails.
    if (/^http:\/\//i.test(trimmed)) return 'https://' + trimmed.slice(7);
    return `https://${trimmed}`;
}

function extractHtmlRedirect(body, baseUrl) {
    if (typeof body !== 'string' || !body.trim()) return '';
    return extractMetaRefreshRedirect(body, baseUrl) || extractJsRedirect(body, baseUrl);
}

function extractJsRedirect(html, baseUrl) {
    // Direct literal: window.location.replace("url") or window.location.href = "url"
    const directMatch = html.match(
        /(?:window\.)?location(?:\.href\s*=|\.replace\s*\()\s*(['"`])(https?:\/\/[^'"`\s]{4,})\1/i
    );
    if (directMatch) {
        try { return new URL(directMatch[2], baseUrl).href; } catch (_) {}
    }

    // Variable pattern: var/let/const name = "https://..."; window.location.replace(name)
    const varRe = /(?:var|let|const)\s+(\w+)\s*=\s*(['"`])(https?:\/\/[^'"`\s]{4,})\2/g;
    let varMatch;
    while ((varMatch = varRe.exec(html)) !== null) {
        const varName = varMatch[1];
        const url = varMatch[3];
        const usageRe = new RegExp(
            `(?:window\\.)?location(?:\\.href\\s*=|\\.replace\\s*\\(|\\s*=)\\s*${varName}\\b`
        );
        if (usageRe.test(html)) {
            try { return new URL(url, baseUrl).href; } catch (_) {}
        }
    }

    return '';
}

function extractMetaRefreshRedirect(html, baseUrl) {
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const meta = doc.querySelector('meta[http-equiv="refresh" i]');
        const content = meta?.getAttribute('content') || '';
        const match = content.match(/url\s*=\s*([^;]+)/i);
        return match ? new URL(stripQuotes(match[1].trim()), baseUrl).href : '';
    } catch (_) {
        return '';
    }
}

function stripQuotes(value) {
    return value.replace(/^['"`]|['"`]$/g, '');
}

function copyResolved() {
    const text = _lastResolution
        ? _preferredDestinationUrl(_lastResolution.finalUrl, _lastResolution.destinations)
        : '';
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => showToast('Copied')).catch(() => showToast('Copy failed'));
}

// ── History ──────────────────────────────────────────────────────────────────

async function loadHistory() {
    const list = document.getElementById('history-list');
    showHistoryLoading();

    if (_historyCache) {
        renderHistory(_historyCache);
    } else {
        list.innerHTML = '<div class="history-loading">Loading history…</div>';
        document.getElementById('history-empty').classList.add('hidden');
    }

    try {
        const scans = await getHistoryScans();
        renderHistory(scans);
    } catch (err) {
        list.innerHTML = `<p class="text-error text-sm px-4">Failed to load history: ${err.message}</p>`;
    } finally {
        hideHistoryLoading();
    }
}

function showHistoryLoading() {
    document.getElementById('history-loading-screen')?.classList.remove('hidden');
    document.getElementById('history-empty')?.classList.add('hidden');
}

function hideHistoryLoading() {
    document.getElementById('history-loading-screen')?.classList.add('hidden');
}

function renderHistory(scans) {
    const list = document.getElementById('history-list');
    const empty = document.getElementById('history-empty');
    list.innerHTML = '';
    if (!scans.length) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');
    for (const scan of scans) {
        list.appendChild(buildHistoryCard(scan));
    }
}

function warmHistoryCache() {
    ScanDB.openDB().catch(() => {});
    getHistoryScans().catch(() => {});
}

async function getHistoryScans({ force = false } = {}) {
    if (_historyCache && !force) return _historyCache;
    if (_historyLoadPromise && !force) return _historyLoadPromise;

    _historyLoadPromise = ScanDB.getAllScans()
        .then(scans => {
            _historyCache = scans;
            return scans;
        })
        .finally(() => {
            _historyLoadPromise = null;
        });
    return _historyLoadPromise;
}

function addScanToHistoryCache(scan) {
    if (!_historyCache) return;
    _historyCache.unshift({
        id: scan.savedId,
        scanned_at: new Date().toISOString(),
        content: scan.content,
        content_type: scan.contentType,
        qr_version: scan.version,
        ecc_level: scan.eccLevel,
        mask_pattern: scan.maskPattern,
        pad_secret: scan.padSecret || null,
        ecc_secret: scan.eccSecret || null,
        final_url: scan.finalUrl || null,
        local_risk_level: scan.localRiskLevel || null,
        google_verdict: scan.googleVerdict || null,
        domain_age_domain: scan.domainAgeDomain || null,
        domain_age_registered_at: scan.domainAgeRegisteredAt || null,
        domain_age_verdict: scan.domainAgeVerdict || null,
        domain_age_level: scan.domainAgeLevel || null,
        vt_verdict: scan.vtVerdict || null
    });
}

function _persistScanPatch(patch) {
    if (!_lastScan?.savedId) return;
    ScanDB.updateScan(_lastScan.savedId, patch).catch(() => {});
    if (_historyCache) {
        const row = _historyCache.find(scan => scan.id === _lastScan.savedId);
        if (row) Object.assign(row, patch);
    }
}

function buildHistoryCard(scan) {
    const card = document.createElement('div');
    card.className = 'history-card';
    const date = new Date(scan.scanned_at);
    const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const preview = scan.content.length > 60 ? scan.content.slice(0, 60) + '…' : scan.content;
    const hasStego = scan.pad_secret || scan.ecc_secret;
    const badges = _historyVerdictBadges(scan, hasStego).join('');

    card.innerHTML = `
        <div class="history-card-header">
            <span class="badge badge-${scan.content_type}">${scan.content_type.toUpperCase()}</span>
            <span class="history-date">${dateStr}</span>
            ${badges}
        </div>
        <div class="history-preview">${escapeHtml(preview)}</div>
        <div class="history-card-actions">
            <button onclick="viewHistoryScan(${scan.id})" class="btn btn-sm btn-secondary">View</button>
            <button onclick="deleteHistoryScan(${scan.id}, this)" class="btn btn-sm btn-danger">Delete</button>
        </div>
    `;
    return card;
}

function _historyVerdictBadges(scan, hasStego) {
    const badges = [];
    if (hasStego) badges.push('<span class="badge badge-stego">STEGO</span>');
    if (scan.local_risk_level === 'threat') badges.push('<span class="badge badge-threat">LOCAL</span>');
    else if (scan.local_risk_level === 'warn') badges.push('<span class="badge badge-warn">LOCAL</span>');
    else if (scan.local_risk_level === 'safe') badges.push('<span class="badge badge-safe">LOCAL</span>');

    if (scan.google_verdict) badges.push(_verdictBadge('GSB', scan.google_verdict));
    if (scan.domain_age_verdict) badges.push(_verdictBadge('AGE', scan.domain_age_verdict));
    if (scan.vt_verdict) badges.push(_verdictBadge('VT', scan.vt_verdict));
    return badges;
}

function _verdictBadge(label, verdict) {
    const lower = String(verdict).toLowerCase();
    const cls = lower.includes('no threats') || lower.includes('not known malicious')
        ? 'badge-safe'
        : lower.includes('malware') || lower.includes('phishing') || lower.includes('threat')
        ? 'badge-threat'
        : lower.includes('failed') || lower.includes('partial') || lower.includes('warning') || lower.includes('suspicious')
            || lower.includes('newly') || lower.includes('recently') || lower.includes('young')
            ? 'badge-warn'
            : 'badge-muted';
    return `<span class="badge ${cls}">${label}</span>`;
}

async function viewHistoryScan(id) {
    try {
        const scan = await ScanDB.getScanById(id);
        if (!scan) return;
        // Re-derive both level and labels from a single fresh analysis so they
        // are always consistent (stored level can be stale if check logic changed).
        const localRisk = scan.content_type === 'url'
            ? analyzeLocalUrlRisks(scan.content)
            : { level: 'none', labels: [] };
        _lastScan = {
            content: scan.content,
            contentType: scan.content_type,
            version: scan.qr_version,
            eccLevel: scan.ecc_level,
            maskPattern: scan.mask_pattern,
            padSecret: scan.pad_secret,
            eccSecret: scan.ecc_secret,
            finalUrl: scan.final_url,
            localRiskLevel: localRisk.level,
            localRiskLabels: localRisk.labels,
            googleVerdict: scan.google_verdict,
            domainAgeDomain: scan.domain_age_domain,
            domainAgeRegisteredAt: scan.domain_age_registered_at,
            domainAgeVerdict: scan.domain_age_verdict,
            domainAgeLevel: scan.domain_age_level,
            vtVerdict: scan.vt_verdict,
            errorsFound: scan.errors_found ?? null,
            dataCodewords: (scan.codewords || []).slice(0, scan.data_count || 0),
            eccCodewords:  (scan.codewords || []).slice(scan.data_count || 0),
            savedId: scan.id
        };
        renderResult(_lastScan);
        showView('result');
    } catch (err) {
        showToast('Failed to load scan');
    }
}

async function deleteHistoryScan(id, btn) {
    try {
        await ScanDB.deleteScan(id);
        if (_historyCache) _historyCache = _historyCache.filter(scan => scan.id !== id);
        btn.closest('.history-card').remove();
        const list = document.getElementById('history-list');
        if (list.children.length === 0) {
            document.getElementById('history-empty').classList.remove('hidden');
        }
    } catch (_) {
        showToast('Delete failed');
    }
}

async function clearHistory() {
    if (!confirm('Delete all scan history?')) return;
    await ScanDB.clearAllScans();
    _historyCache = [];
    renderHistory(_historyCache);
}

// ── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    t.classList.add('show');
    setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.classList.add('hidden'), 300);
    }, 2200);
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

// ── Raw QR Data display ───────────────────────────────────────────────────────

function renderRawQrData(scan) {
    const section = document.getElementById('raw-qr-section');
    if (!section) return;

    const hasData = (scan.dataCodewords?.length > 0) || (scan.eccCodewords?.length > 0);
    section.classList.toggle('hidden', !hasData);
    if (!hasData) return;

    // Collapse accordion whenever a new scan arrives
    const body = document.getElementById('raw-qr-body');
    const chevron = document.getElementById('raw-qr-chevron');
    body.classList.add('hidden');
    if (chevron) chevron.classList.remove('open');

    // Pre-populate content so it's ready when the user opens it
    _populateRawQrPanels(scan);
}

function _populateRawQrPanels(scan) {
    const data = scan.dataCodewords || [];
    const ecc  = scan.eccCodewords  || [];

    const errText = scan.errorsFound === null ? 'N/A' : String(scan.errorsFound);
    const errLabel = scan.errorsFound === null
        ? 'damaged codewords: N/A'
        : `${errText} damaged codeword${scan.errorsFound === 1 ? '' : 's'}`;
    document.getElementById('raw-qr-format').textContent =
        `Version ${scan.version}  ·  ECC ${scan.eccLevel}  ·  Mask ${scan.maskPattern}  ·  ${errLabel}`;
    document.getElementById('raw-qr-counts').textContent =
        `data · ${data.length}  ·  ecc · ${ecc.length}`;

    document.getElementById('raw-qr-data').textContent = _formatHexBlock(data);
    document.getElementById('raw-qr-ecc').textContent  = _formatHexBlock(ecc);
}

function _formatHexBlock(bytes) {
    if (!bytes || bytes.length === 0) return '(empty)';
    const COLS = 8;
    const lines = [];
    for (let i = 0; i < bytes.length; i += COLS) {
        const chunk = bytes.slice(i, i + COLS);
        const hex = chunk.map(b => b.toString(16).padStart(2, '0')).join(' ');
        const off = i.toString(16).padStart(4, '0');
        lines.push(`${off}  ${hex}`);
    }
    return lines.join('\n');
}

function copyHexBlock(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    // Each line: "0000  aa bb cc dd ..." — strip the 6-char offset prefix
    const hex = el.textContent.split('\n')
        .map(line => line.slice(6))
        .join(' ')
        .trim();
    navigator.clipboard.writeText(hex).then(() => showToast('Copied'));
}

function toggleRawQrData() {
    const body    = document.getElementById('raw-qr-body');
    const chevron = document.getElementById('raw-qr-chevron');
    const open = body.classList.toggle('hidden');  // toggle returns true if now hidden
    if (chevron) chevron.classList.toggle('open', !open);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    warmHistoryCache();
    showView('scanner');
});
