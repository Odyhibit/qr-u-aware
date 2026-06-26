'use strict';

// SecureKeys — persists API secrets using the strongest available mechanism.
//
// Native iOS/Android (App Store build):
//   Uses @capacitor-community/capacitor-secure-storage-plugin, which wraps
//   iOS Keychain (kSecAttrAccessibleWhenUnlockedThisDeviceOnly) and Android
//   secure storage backed by the Android Keystore. The exact hardware backing
//   depends on the platform, device, OS version, and plugin implementation.
//
// Browser / web-only mode:
//   Uses Web Crypto AES-256-GCM. A random master key is generated once and
//   persisted as a JWK in IndexedDB; each secret is individually encrypted
//   with a fresh IV and stored alongside it. This provides origin isolation
//   and protects against casual inspection of storage, but is NOT equivalent
//   to hardware-backed keychain storage. The Settings page makes this clear.

const SecureKeys = (() => {
    const _DB_NAME  = 'qrs_sk_v1';
    const _STORE    = 'entries';
    const _MK_KEY   = '\x00mk\x00'; // sentinel — unlikely to collide with user keys

    let _dbPromise     = null;
    let _masterCryptoKey = null;

    // ── IndexedDB helpers ────────────────────────────────────────────────────

    function _openDB() {
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(_DB_NAME, 1);
            req.onupgradeneeded = ev => ev.target.result.createObjectStore(_STORE);
            req.onsuccess  = ev => resolve(ev.target.result);
            req.onerror    = () => { _dbPromise = null; reject(req.error); };
        });
        return _dbPromise;
    }

    async function _idbGet(key) {
        const db = await _openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction(_STORE, 'readonly').objectStore(_STORE).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror   = () => reject(req.error);
        });
    }

    async function _idbPut(key, value) {
        const db = await _openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction(_STORE, 'readwrite').objectStore(_STORE).put(value, key);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    async function _idbDelete(key) {
        const db = await _openDB();
        return new Promise((resolve, reject) => {
            const req = db.transaction(_STORE, 'readwrite').objectStore(_STORE).delete(key);
            req.onsuccess = () => resolve();
            req.onerror   = () => reject(req.error);
        });
    }

    // ── Web Crypto master key ────────────────────────────────────────────────

    async function _getMasterKey() {
        if (_masterCryptoKey) return _masterCryptoKey;

        const stored = await _idbGet(_MK_KEY);
        if (stored) {
            _masterCryptoKey = await crypto.subtle.importKey(
                'jwk', stored,
                { name: 'AES-GCM', length: 256 },
                false, ['encrypt', 'decrypt']
            );
            return _masterCryptoKey;
        }

        // First run — generate and persist a new master key.
        const key = await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
        );
        const jwk = await crypto.subtle.exportKey('jwk', key);
        await _idbPut(_MK_KEY, jwk);

        // Reimport as non-extractable for all subsequent use this session.
        _masterCryptoKey = await crypto.subtle.importKey(
            'jwk', jwk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
        return _masterCryptoKey;
    }

    // ── Native plugin reference ──────────────────────────────────────────────

    function _plugin() {
        return window.Capacitor?.Plugins?.SecureStoragePlugin ?? null;
    }

    function _isNative() {
        return Boolean(_plugin() && window.Capacitor?.isNativePlatform?.());
    }

    // ── Public API ───────────────────────────────────────────────────────────

    async function set(name, value) {
        if (_isNative()) {
            await _plugin().set({ key: name, value: String(value) });
            return;
        }
        const masterKey = await _getMasterKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            masterKey,
            new TextEncoder().encode(value)
        );
        await _idbPut(name, { iv: Array.from(iv), ct: Array.from(new Uint8Array(ct)) });
    }

    async function get(name) {
        if (_isNative()) {
            try { return (await _plugin().get({ key: name })).value ?? null; }
            catch (_) { return null; }
        }
        const entry = await _idbGet(name);
        if (!entry) return null;
        try {
            const masterKey = await _getMasterKey();
            const pt = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: new Uint8Array(entry.iv) },
                masterKey,
                new Uint8Array(entry.ct)
            );
            return new TextDecoder().decode(pt);
        } catch (_) {
            return null;
        }
    }

    async function remove(name) {
        if (_isNative()) {
            try { await _plugin().remove({ key: name }); } catch (_) {}
            return;
        }
        await _idbDelete(name);
    }

    // True only when the native Keychain/Keystore plugin is active.
    function isHardwareBacked() {
        return _isNative();
    }

    return { set, get, remove, isHardwareBacked };
})();
