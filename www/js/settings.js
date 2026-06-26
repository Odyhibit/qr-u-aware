'use strict';

const _KEY_GSB = 'gsb_api_key';
const _KEY_VT  = 'vt_api_key';
const _PREF_AUTO_GSB = 'qr_pref_auto_gsb';
const _PREF_AUTO_VT = 'qr_pref_auto_vt';
const _PREF_AUTO_REDIRECTS = 'qr_pref_auto_redirects';
const _PREF_AUTO_DOMAIN_AGE = 'qr_pref_auto_domain_age';
const _PREF_ADVANCED_MODE = 'qr_pref_advanced_mode';

function isAdvancedMode() {
    return localStorage.getItem(_PREF_ADVANCED_MODE) === '1';
}

function saveAdvancedMode(value) {
    localStorage.setItem(_PREF_ADVANCED_MODE, value ? '1' : '0');
}

async function initSettings() {
    _updateStorageNote();
    const [gsbKey, storedGsb, vt] = await Promise.all([
        getGsbApiKey(), SecureKeys.get(_KEY_GSB), SecureKeys.get(_KEY_VT)
    ]);
    if (storedGsb) document.getElementById('setting-gsb-key').value = storedGsb;
    if (vt)        document.getElementById('setting-vt-key').value  = vt;
    _loadNetworkPreferences(Boolean(gsbKey), Boolean(vt));
    _bindGsbKeyAvailability();
    _bindVtKeyAvailability();
    _loadAdvancedMode();
    _bindAdvancedMode();
}

function _loadAdvancedMode() {
    document.getElementById('setting-advanced-mode').checked = isAdvancedMode();
}

function _bindAdvancedMode() {
    const el = document.getElementById('setting-advanced-mode');
    if (el.dataset.boundMode === '1') return;
    el.dataset.boundMode = '1';
    el.addEventListener('change', () => saveAdvancedMode(el.checked));
}

function _updateStorageNote() {
    const el = document.getElementById('storage-security-info');
    if (SecureKeys.isHardwareBacked()) {
        el.innerHTML = `
            <div class="sec-info sec-info-strong">
                <div class="sec-info-icon">&#x1F512;</div>
                <div class="sec-info-body">
                    <strong>Hardware-backed secure storage</strong>
                    <p>Keys are stored with your device’s native secure storage APIs: Keychain on iOS and Keystore-backed storage on Android. They are device-specific and never transmitted anywhere.</p>
                </div>
            </div>`;
    } else {
        el.innerHTML = `
            <div class="sec-info sec-info-soft">
                <div class="sec-info-icon">&#x1F510;</div>
                <div class="sec-info-body">
                    <strong>Software-encrypted storage</strong>
                    <p>Running in browser mode. Keys are encrypted with AES-256-GCM using a random master key stored in sandboxed IndexedDB. This provides origin isolation but is not equivalent to hardware-backed Keychain or Keystore. For the strongest protection, use the native iOS or Android app.</p>
                </div>
            </div>`;
    }
}

async function saveApiKeys() {
    const gsbVal = document.getElementById('setting-gsb-key').value.trim();
    const vtVal  = document.getElementById('setting-vt-key').value.trim();
    const autoGsb = gsbVal && document.getElementById('setting-auto-gsb').checked;
    const autoRedirects = document.getElementById('setting-auto-redirects').checked;
    const autoDomainAge = document.getElementById('setting-auto-domain-age').checked;
    const autoVt = vtVal && document.getElementById('setting-auto-vt').checked;

    const btn = document.getElementById('settings-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        if (gsbVal) {
            await SecureKeys.set(_KEY_GSB, gsbVal);
        } else {
            await SecureKeys.remove(_KEY_GSB);
        }
        if (vtVal) {
            await SecureKeys.set(_KEY_VT, vtVal);
        } else {
            await SecureKeys.remove(_KEY_VT);
        }
        saveNetworkPreferences({
            autoGsb: Boolean(autoGsb),
            autoVt: Boolean(autoVt),
            autoRedirects,
            autoDomainAge
        });
        _setGsbAutoAvailable(Boolean(gsbVal));
        _setVtAutoAvailable(Boolean(vtVal));
        showToast('Settings saved');
    } catch (err) {
        showToast('Save failed: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save Settings';
    }
}

async function clearGsbKey() {
    if (!confirm('Clear saved Google Safe Browsing API key?')) return;
    await SecureKeys.remove(_KEY_GSB);
    document.getElementById('setting-gsb-key').value = '';
    document.getElementById('setting-auto-gsb').checked = false;
    saveNetworkPreferences({ ...getNetworkPreferences(), autoGsb: false });
    _setGsbAutoAvailable(false);
    showToast('Google Safe Browsing key cleared');
}

async function clearApiKeys() {
    if (!confirm('Clear saved VirusTotal API key?')) return;
    await SecureKeys.remove(_KEY_VT);
    document.getElementById('setting-vt-key').value  = '';
    document.getElementById('setting-auto-vt').checked = false;
    saveNetworkPreferences({ ...getNetworkPreferences(), autoVt: false });
    _setVtAutoAvailable(false);
    showToast('VirusTotal key cleared');
}

function toggleKeyVisibility(inputId, btnEl) {
    const input = document.getElementById(inputId);
    const showing = input.type === 'text';
    input.type   = showing ? 'password' : 'text';
    btnEl.textContent = showing ? 'Show' : 'Hide';
}

// Called by app.js when retrieving keys for API calls.
async function getGsbApiKey() {
    return await SecureKeys.get(_KEY_GSB) || window.QR_STEGO_CONFIG?.googleSafeBrowsingApiKey || '';
}
async function getVtApiKey()  { return SecureKeys.get(_KEY_VT);  }

function getNetworkPreferences() {
    return {
        autoGsb:       localStorage.getItem(_PREF_AUTO_GSB)       !== '0',
        autoVt:        localStorage.getItem(_PREF_AUTO_VT)         === '1',
        autoRedirects: localStorage.getItem(_PREF_AUTO_REDIRECTS)  !== '0',
        autoDomainAge: localStorage.getItem(_PREF_AUTO_DOMAIN_AGE) !== '0'
    };
}

function saveNetworkPreferences(prefs) {
    localStorage.setItem(_PREF_AUTO_GSB, prefs.autoGsb ? '1' : '0');
    localStorage.setItem(_PREF_AUTO_VT, prefs.autoVt ? '1' : '0');
    localStorage.setItem(_PREF_AUTO_REDIRECTS, prefs.autoRedirects ? '1' : '0');
    localStorage.setItem(_PREF_AUTO_DOMAIN_AGE, prefs.autoDomainAge ? '1' : '0');
}

function _loadNetworkPreferences(hasGsbKey, hasVtKey) {
    const prefs = getNetworkPreferences();
    document.getElementById('setting-auto-gsb').checked = hasGsbKey && prefs.autoGsb;
    document.getElementById('setting-auto-redirects').checked = prefs.autoRedirects;
    document.getElementById('setting-auto-domain-age').checked = prefs.autoDomainAge;
    document.getElementById('setting-auto-vt').checked = hasVtKey && prefs.autoVt;
    _setGsbAutoAvailable(hasGsbKey);
    _setVtAutoAvailable(hasVtKey);
}

function _bindGsbKeyAvailability() {
    const input = document.getElementById('setting-gsb-key');
    if (input.dataset.boundAvailability === '1') return;
    input.dataset.boundAvailability = '1';
    input.addEventListener('input', () => _setGsbAutoAvailable(Boolean(input.value.trim())));
}

function _setGsbAutoAvailable(hasGsbKey) {
    const checkbox = document.getElementById('setting-auto-gsb');
    const hint = document.getElementById('setting-auto-gsb-hint');
    checkbox.disabled = !hasGsbKey;
    if (!hasGsbKey) checkbox.checked = false;
    hint.textContent = hasGsbKey
        ? 'Sends scanned URLs to Google Safe Browsing for malware and phishing checks.'
        : 'Set a Google Safe Browsing API key before enabling automatic checks.';
}

function _bindVtKeyAvailability() {
    const input = document.getElementById('setting-vt-key');
    if (input.dataset.boundAvailability === '1') return;
    input.dataset.boundAvailability = '1';
    input.addEventListener('input', () => _setVtAutoAvailable(Boolean(input.value.trim())));
}

function _setVtAutoAvailable(hasVtKey) {
    const checkbox = document.getElementById('setting-auto-vt');
    const hint = document.getElementById('setting-auto-vt-hint');
    checkbox.disabled = !hasVtKey;
    if (!hasVtKey) checkbox.checked = false;
    hint.textContent = hasVtKey
        ? 'When enabled, URL scan results can be submitted to VirusTotal automatically.'
        : 'Set a VirusTotal API key before enabling automatic VirusTotal scans.';
}
