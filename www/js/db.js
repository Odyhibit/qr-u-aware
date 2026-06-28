// IndexedDB wrapper for scan history

const DB_NAME = 'qr_stego_db';
const DB_VERSION = 1;
const STORE = 'scans';

let _db = null;

function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
                store.createIndex('scanned_at', 'scanned_at', { unique: false });
            }
        };
        req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
        req.onerror = (e) => reject(e.target.error);
    });
}

async function saveScan(scan) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).add({
            scanned_at: new Date().toISOString(),
            content: scan.content,
            content_type: scan.contentType,
            qr_version: scan.version,
            ecc_level: scan.eccLevel,
            mask_pattern: scan.maskPattern,
            pad_secret: scan.padSecret || null,
            ecc_secret: scan.eccSecret || null,
            errors_found: scan.errorsFound ?? null,
            codewords: (scan.dataCodewords?.length || scan.eccCodewords?.length)
                ? [...(scan.dataCodewords || []), ...(scan.eccCodewords || [])]
                : null,
            data_count: scan.dataCodewords?.length || null,
            final_url: scan.finalUrl || null,
            local_risk_level: scan.localRiskLevel || null,
            google_verdict: scan.googleVerdict || null,
            vt_verdict: scan.vtVerdict || null
        });
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

async function updateScan(id, patch) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const getReq = store.get(id);
        getReq.onsuccess = () => {
            const row = getReq.result;
            if (!row) {
                resolve();
                return;
            }
            const putReq = store.put({ ...row, ...patch });
            putReq.onsuccess = () => resolve();
            putReq.onerror = (e) => reject(e.target.error);
        };
        getReq.onerror = (e) => reject(e.target.error);
    });
}

async function getAllScans() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).index('scanned_at').getAll();
        req.onsuccess = () => resolve(req.result.reverse());
        req.onerror = (e) => reject(e.target.error);
    });
}

async function getScanById(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

async function deleteScan(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).delete(id);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
    });
}

async function clearAllScans() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
    });
}

window.ScanDB = { openDB, saveScan, updateScan, getAllScans, getScanById, deleteScan, clearAllScans };
