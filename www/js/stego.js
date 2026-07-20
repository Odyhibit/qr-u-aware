// QR Code Steganography Decoder/Encoder Module (GJ-based approach)
//
// Hides a message in ECC bytes by solving for padding values that produce
// the desired ECC output. The QR is 100% valid — no bytes are overwritten.

// ── Reed-Solomon helpers for ECC validation/error counting ───────────────────
// GF(256) with primitive polynomial 0x011D (same field used by QR codes).

const _gfExp = new Uint8Array(512); // 512 so we never wrap in multiply
const _gfLog = new Uint8Array(256);
(function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        _gfExp[i] = x; _gfExp[i + 255] = x;
        _gfLog[x] = i;
        x = ((x << 1) ^ (x & 0x80 ? 0x1D : 0)) & 0xFF;
    }
})();

function _gfMul(a, b) {
    return (a === 0 || b === 0) ? 0 : _gfExp[_gfLog[a] + _gfLog[b]];
}

function _gfDiv(a, b) {
    if (b === 0) throw new Error('GF division by zero');
    return a === 0 ? 0 : _gfExp[(_gfLog[a] - _gfLog[b] + 255) % 255];
}

// Build the RS generator polynomial g(x) = prod((x + α^i) for i=0..eccLen-1)
const _genCache = new Map();
function _rsGenerator(eccLen) {
    if (_genCache.has(eccLen)) return _genCache.get(eccLen);
    let gen = [1];
    for (let i = 0; i < eccLen; i++) {
        const root = _gfExp[i];
        const next = new Array(gen.length + 1).fill(0);
        for (let j = 0; j < gen.length; j++) {
            next[j] ^= gen[j];
            next[j + 1] ^= _gfMul(gen[j], root);
        }
        gen = next;
    }
    _genCache.set(eccLen, gen);
    return gen;
}

// Compute ECC bytes for a block of data using polynomial long division.
function _computeEcc(data, eccLen) {
    const gen = _rsGenerator(eccLen);
    const rem = new Uint8Array(eccLen);
    for (const byte of data) {
        const factor = byte ^ rem[0];
        rem.copyWithin(0, 1);
        rem[eccLen - 1] = 0;
        if (factor !== 0) {
            for (let i = 0; i < eccLen; i++) {
                rem[i] ^= _gfMul(gen[i + 1], factor);
            }
        }
    }
    return rem;
}

// Parse the header of the QR data bit stream to detect ECI and byte mode.
// Returns { eciDesignator (null if none), dataStartBit } or null if unsupported.
function _parseQrHeader(dataCodewords, version) {
    const bits = [];
    for (const b of dataCodewords.slice(0, 12)) {
        for (let j = 7; j >= 0; j--) bits.push((b >> j) & 1);
    }
    let pos = 0;
    const read = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | (bits[pos++] || 0); return v; };

    let eciDesignator = null;
    const firstMode = read(4);

    if (firstMode === 7) { // ECI header present
        const b0 = read(8);
        if ((b0 & 0x80) === 0) {           // 0xxxxxxx → 7-bit designator
            eciDesignator = b0 & 0x7F;
        } else if ((b0 & 0xC0) === 0x80) { // 10xxxxxx → 14-bit designator
            eciDesignator = ((b0 & 0x3F) << 8) | read(8);
        } else {                            // 110xxxxx → 21-bit designator
            eciDesignator = ((b0 & 0x1F) << 16) | (read(8) << 8) | read(8);
        }
        const byteMode = read(4);
        if (byteMode !== 4) return null; // unsupported segment type after ECI
    } else if (firstMode !== 4) {
        return null; // unsupported mode
    }

    const ccBits = version <= 9 ? 8 : 16;
    read(ccBits); // skip character count — we use msgBytes.length instead
    return { eciDesignator, dataStartBit: pos };
}

// Reconstruct the ideal QR data codeword stream from the ZXing-decoded payload.
// Handles plain byte mode and ECI + byte mode.
function _buildCleanDataCodewords(msgBytes, version, totalDataBytes, eciDesignator) {
    if (!msgBytes || !msgBytes.length) return null;
    const bits = [];

    if (eciDesignator !== null) {
        bits.push(0, 1, 1, 1); // ECI mode indicator
        if (eciDesignator < 128) {
            bits.push(0);
            for (let i = 6; i >= 0; i--) bits.push((eciDesignator >> i) & 1);
        } else if (eciDesignator < 16384) {
            bits.push(1, 0);
            for (let i = 13; i >= 0; i--) bits.push((eciDesignator >> i) & 1);
        } else {
            bits.push(1, 1, 0);
            for (let i = 20; i >= 0; i--) bits.push((eciDesignator >> i) & 1);
        }
    }

    bits.push(0, 1, 0, 0); // byte mode indicator
    const ccBits = version <= 9 ? 8 : 16;
    for (let i = ccBits - 1; i >= 0; i--) bits.push((msgBytes.length >> i) & 1);
    for (const b of msgBytes) {
        for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    }
    const cap = totalDataBytes * 8;
    for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0); // terminator
    while (bits.length % 8 !== 0) bits.push(0);                    // byte-align
    for (let fill = 0; bits.length < cap; fill ^= 1) {             // fill bytes
        const fb = fill ? 0x11 : 0xEC;
        for (let i = 7; i >= 0 && bits.length < cap; i--) bits.push((fb >> i) & 1);
    }
    const out = new Uint8Array(totalDataBytes);
    for (let i = 0; i < totalDataBytes; i++) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i * 8 + j] || 0);
        out[i] = b;
    }
    return out;
}

function countEccMismatches(dataCodewords, eccCodewords, blockInfo) {
    if (!dataCodewords?.length || !eccCodewords?.length || !blockInfo) return null;

    let dataOff = 0;
    let eccOff = 0;
    let mismatches = 0;

    for (const dLen of blockInfo.dataBlockLens) {
        const dataBlock = dataCodewords.slice(dataOff, dataOff + dLen);
        const expectedEcc = _computeEcc(new Uint8Array(dataBlock), blockInfo.eccPerBlock);
        for (let i = 0; i < blockInfo.eccPerBlock; i++) {
            if (eccCodewords[eccOff + i] !== expectedEcc[i]) mismatches++;
        }
        dataOff += dLen;
        eccOff += blockInfo.eccPerBlock;
    }

    return mismatches;
}

// Recompute the true ECC codewords (deinterleaved block order) from a corrected
// data-codeword stream. For any scannable QR the real ECC equals RS(data) —
// including GJ-stego ECC payloads, which are valid RS codewords by construction.
function recomputeBlockEcc(dataCodewords, blockInfo) {
    const out = [];
    let off = 0;
    for (const dLen of blockInfo.dataBlockLens) {
        out.push(..._computeEcc(new Uint8Array(dataCodewords.slice(off, off + dLen)), blockInfo.eccPerBlock));
        off += dLen;
    }
    return out;
}

function _rsSyndromes(codewords, eccLen) {
    const syndromes = [];
    for (let i = 0; i < eccLen; i++) {
        const x = _gfExp[i];
        let y = 0;
        for (const b of codewords) {
            y = _gfMul(y, x) ^ b;
        }
        syndromes.push(y);
    }
    return syndromes;
}

function _trimPoly(poly) {
    while (poly.length > 1 && poly[poly.length - 1] === 0) poly.pop();
    return poly;
}

function _rsErrorCountForBlock(dataBlock, eccBlock, eccLen) {
    const syndromes = _rsSyndromes([...dataBlock, ...eccBlock], eccLen);
    if (syndromes.every(v => v === 0)) return 0;

    // Berlekamp-Massey over GF(256). The degree of the locator polynomial is
    // the number of corrupted codeword locations when errors are correctable.
    let c = [1];
    let b = [1];
    let l = 0;
    let m = 1;
    let bb = 1;

    for (let n = 0; n < eccLen; n++) {
        let d = syndromes[n];
        for (let i = 1; i <= l; i++) {
            d ^= _gfMul(c[i] || 0, syndromes[n - i]);
        }

        if (d === 0) {
            m++;
            continue;
        }

        const t = c.slice();
        const coef = _gfDiv(d, bb);
        for (let i = 0; i < b.length; i++) {
            c[i + m] = (c[i + m] || 0) ^ _gfMul(coef, b[i]);
        }

        if (2 * l <= n) {
            l = n + 1 - l;
            b = t;
            bb = d;
            m = 1;
        } else {
            m++;
        }
    }

    _trimPoly(c);
    return l <= Math.floor(eccLen / 2) ? l : null;
}

function countCorrectableCodewordErrors(dataCodewords, eccCodewords, blockInfo) {
    if (!dataCodewords?.length || !eccCodewords?.length || !blockInfo) return null;

    let dataOff = 0;
    let eccOff = 0;
    let total = 0;

    for (const dLen of blockInfo.dataBlockLens) {
        const dataBlock = dataCodewords.slice(dataOff, dataOff + dLen);
        const eccBlock = eccCodewords.slice(eccOff, eccOff + blockInfo.eccPerBlock);
        const count = _rsErrorCountForBlock(dataBlock, eccBlock, blockInfo.eccPerBlock);
        if (count === null) return null;
        total += count;
        dataOff += dLen;
        eccOff += blockInfo.eccPerBlock;
    }

    return total;
}

// ── Finder-calibrated module classification ─────────────────────────────────
//
// A fixed threshold (luma < 128) misreads low-contrast and color-inverted
// codes (e.g. engraved/shiny coins where modules are lighter than the
// background). The three finder patterns have known geometry — dark 7×7 ring
// and 3×3 center, light ring between them — so sampling those positions tells
// us both the symbol's real dark/light levels and its polarity.

function _finderReferenceCoords(size) {
    const dark = [];
    const light = [];
    for (const [cx, cy] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
        for (let dy = 0; dy < 7; dy++) {
            for (let dx = 0; dx < 7; dx++) {
                const border = dx === 0 || dx === 6 || dy === 0 || dy === 6;
                const center = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
                (border || center ? dark : light).push([cx + dx, cy + dy]);
            }
        }
    }
    return { dark, light };
}

function _median(values) {
    if (!values.length) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// lumaAt(col, row) → 0..255 (or NaN when unreadable). Returns { threshold,
// invert }: a module is dark when (luma < threshold) !== invert. Falls back to
// the historical fixed threshold when the finder samples don't separate into
// two convincing levels (min. 16 luma units apart).
function calibrateModulePolarity(lumaAt, size) {
    const MIN_SEPARATION = 16;
    try {
        const { dark, light } = _finderReferenceCoords(size);
        const darkMed = _median(dark.map(([x, y]) => lumaAt(x, y)).filter(Number.isFinite));
        const lightMed = _median(light.map(([x, y]) => lumaAt(x, y)).filter(Number.isFinite));
        if (!Number.isFinite(darkMed) || !Number.isFinite(lightMed) ||
            Math.abs(lightMed - darkMed) < MIN_SEPARATION) {
            return { threshold: 128, invert: false };
        }
        return { threshold: (darkMed + lightMed) / 2, invert: darkMed > lightMed };
    } catch (_) {
        return { threshold: 128, invert: false };
    }
}

const textEncoder = new TextEncoder();

function utf8Bytes(str) {
    return textEncoder.encode(str || '');
}

function packBitsToBytes(bits) {
    const out = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) {
        out[i >> 3] |= (bits[i] & 1) << (7 - (i & 7));
    }
    return out;
}

function byteModeCharCountBits(version) {
    return version <= 9 ? 8 : 16;
}

function maskFormula(mask, x, y) {
    switch (mask) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
        case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
        case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
        case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        default: return false;
    }
}

function getDataCoords(version) {
    const size = version * 4 + 17;
    const coords = [];
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        for (let i = 0; i < size; i++) {
            const y = upward ? (size - 1 - i) : i;
            for (let dx = 0; dx < 2; dx++) {
                const x = col - dx;
                if (QRParser.isFunctionPattern(x, y, size, version)) continue;
                coords.push({ x, y });
            }
        }
        upward = !upward;
    }
    return coords;
}

function computeBlockInfo(version, eccLevel) {
    if (typeof qrcodegen === 'undefined' || !qrcodegen.QrCode) {
        throw new Error('qrcodegen not loaded');
    }
    const eccMap = { L: qrcodegen.QrCode.Ecc.LOW, M: qrcodegen.QrCode.Ecc.MEDIUM, Q: qrcodegen.QrCode.Ecc.QUARTILE, H: qrcodegen.QrCode.Ecc.HIGH };
    const ecc = eccMap[eccLevel];
    if (!ecc) throw new Error(`Invalid ECC ${eccLevel}`);

    const dataCodewords = qrcodegen.QrCode.getNumDataCodewords(version, ecc);
    const blocks = qrcodegen.QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version];
    const eccPerBlock = qrcodegen.QrCode.ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version];

    const numLong = dataCodewords % blocks;
    const numShort = blocks - numLong;
    const shortLen = Math.floor(dataCodewords / blocks);
    const longLen = shortLen + 1;
    const dataBlockLens = [];
    for (let i = 0; i < numShort; i++) dataBlockLens.push(shortLen);
    for (let i = 0; i < numLong; i++) dataBlockLens.push(longLen);

    return {
        dataCodewords,
        totalBlocks: blocks,
        eccPerBlock,
        dataBlockLens
    };
}

function calcPadCapacity(decoyLen, version, dataCodewords) {
    const capacityBits = dataCodewords * 8;
    const ccBits = byteModeCharCountBits(version);
    const used = 4 + ccBits + 8 * decoyLen;
    const term = Math.min(4, capacityBits - used);
    const afterTerm = used + term;
    const padStart = afterTerm + ((-afterTerm) % 8);
    const padBytesCapacity = Math.floor((capacityBits - padStart) / 8);
    return { padStart, padBytesCapacity, capacityBits };
}

function buildDataCodewords(decoy, paddingSecret, version, eccLevel) {
    const decoyBytes = utf8Bytes(decoy);
    const padBytes = utf8Bytes(paddingSecret);
    if (padBytes.length > 255) {
        throw new Error('Padding secret too long for 1-byte length prefix (max 255 bytes).');
    }
    const blockInfo = computeBlockInfo(version, eccLevel);
    const padInfo = calcPadCapacity(decoyBytes.length, version, blockInfo.dataCodewords);
    const padBytesCapacity = padInfo.padBytesCapacity;
    const capacityBits = padInfo.capacityBits;

    if (padBytes.length + 1 > padBytesCapacity) {
        throw new Error(`Padding secret too long: need ${padBytes.length + 1} bytes, have ${padBytesCapacity}.`);
    }

    const bits = [];
    // byte mode indicator
    bits.push(0, 1, 0, 0);
    const ccBits = byteModeCharCountBits(version);
    for (let i = 0; i < ccBits; i++) {
        bits.push((decoyBytes.length >> (ccBits - 1 - i)) & 1);
    }
    decoyBytes.forEach((b) => {
        for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    });

    const term = Math.min(4, capacityBits - bits.length);
    for (let i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);

    // padding secret (length-prefixed)
    if (padBytes.length) {
        const lenPrefix = [padBytes.length & 0xff];
        [...lenPrefix, ...padBytes].forEach((b) => {
            for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
        });
    }

    // Standard QR padding bytes (0xEC / 0x11 alternating) for unused codewords.
    // These are the fill bytes mandated by the spec; using zeros instead causes
    // visually abnormal patterns under most masks.
    let padByteCount = 0;
    while (bits.length < capacityBits) {
        const fillByte = (padByteCount % 2 === 0) ? 0xEC : 0x11;
        padByteCount++;
        for (let i = 7; i >= 0; i--) bits.push((fillByte >> i) & 1);
    }

    return {
        dataCodewords: Array.from(packBitsToBytes(bits.slice(0, capacityBits))),
        padBytesCapacity,
        dataCapacityBytes: blockInfo.dataCodewords
    };
}

function extractAllBits(modules, version, mask, totalBits) {
    const coords = getDataCoords(version);
    const bits = [];
    for (let i = 0; i < totalBits && i < coords.length; i++) {
        const { x, y } = coords[i];
        const bit = modules[y][x] ? 1 : 0;
        bits.push(bit ^ (maskFormula(mask, x, y) ? 1 : 0));
    }
    return { bits, coords };
}

function applyBitsToModules(baseModules, version, mask, coords, bits) {
    const modules = baseModules.map((row) => row.slice());
    for (let i = 0; i < bits.length && i < coords.length; i++) {
        const { x, y } = coords[i];
        modules[y][x] = Boolean(bits[i] ^ (maskFormula(mask, x, y) ? 1 : 0));
    }
    return modules;
}

function drawModules(modules, scale = 8, border = 4) {
    const size = modules.length;
    const canvas = document.createElement('canvas');
    canvas.width = (size + border * 2) * scale;
    canvas.height = (size + border * 2) * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (modules[y][x]) {
                ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
            }
        }
    }
    return canvas;
}

// ─────────────────────── Reed-Solomon (via qrcodegen) ─────────────────────────
//
// GJBlock must use the SAME RS polynomial as qrcodegen so that data bytes
// solved by GJ produce the expected ECC when qrcodegen recomputes it.
// qrcodegen stores the generator polynomial highest-to-lowest excluding the
// monic leading term; the old hand-rolled reedSolomon stored it reversed,
// causing a coefficient-order mismatch that corrupted every ECC payload.

const _rsDivisorCache = new Map();

function reedSolomon(data, eccLen) {
    if (!_rsDivisorCache.has(eccLen)) {
        _rsDivisorCache.set(eccLen, qrcodegen.QrCode.reedSolomonComputeDivisor(eccLen));
    }
    return qrcodegen.QrCode.reedSolomonComputeRemainder(
        Array.from(data), _rsDivisorCache.get(eccLen)
    );
}

// ─────────────────────── Gauss-Jordan block solver ────────────────────────────
//
// Port of ecc_payload_stego.py GJBlock class.
// Builds a constraint matrix where row i encodes how flipping data bit i
// propagates into the full codeword (data + ECC bytes) via Reed-Solomon.

class GJBlock {
    constructor(data, nEcc) {
        this.nd = data.length;
        this.nc = nEcc;
        // current codeword = data bytes + RS(data)
        this.b = [...data, ...Array.from(reedSolomon(data, nEcc))];

        // constraint matrix: nd*8 rows, each of length (nd + nc) bytes
        this._active = [];
        for (let i = 0; i < this.nd * 8; i++) {
            const rowData = new Array(this.nd).fill(0);
            rowData[i >> 3] = 1 << (7 - (i & 7));
            const eccPart = Array.from(reedSolomon(rowData, nEcc));
            this._active.push([...rowData, ...eccPart]);
        }
        this._used = [];
    }

    _canSet(bitInData, value) {
        const byteIdx = bitInData >> 3;
        const mask = 1 << (7 - (bitInData & 7));
        let pi = -1;
        for (let j = 0; j < this._active.length; j++) {
            if (this._active[j][byteIdx] & mask) { pi = j; break; }
        }
        if (pi === -1) return false;
        if (pi !== 0) [this._active[0], this._active[pi]] = [this._active[pi], this._active[0]];
        const targ = this._active[0];
        for (let j = 1; j < this._active.length; j++) {
            if (this._active[j][byteIdx] & mask) {
                for (let k = 0; k < targ.length; k++) this._active[j][k] ^= targ[k];
            }
        }
        for (const row of this._used) {
            if (row[byteIdx] & mask) for (let k = 0; k < targ.length; k++) row[k] ^= targ[k];
        }
        if (((this.b[byteIdx] & mask) !== 0) !== Boolean(value)) {
            for (let k = 0; k < this.b.length; k++) this.b[k] ^= targ[k];
        }
        this._used.push(targ);
        this._active.shift();
        return true;
    }

    // Consume the degree of freedom for data bit `bit` (locking it to its current value).
    lockBit(bit) {
        this._canSet(bit, (this.b[bit >> 3] >> (7 - (bit & 7))) & 1);
    }

    // Drive ECC byte eccByte, bit bitInByte (0=MSB) to `value` using a free pivot row.
    setEccBit(eccByte, bitInByte, value) {
        const cwIdx = this.nd + eccByte;
        const mask = 1 << (7 - bitInByte);
        let pi = -1;
        for (let j = 0; j < this._active.length; j++) {
            if (this._active[j][cwIdx] & mask) { pi = j; break; }
        }
        if (pi === -1) return false;
        if (pi !== 0) [this._active[0], this._active[pi]] = [this._active[pi], this._active[0]];
        const targ = this._active[0];
        for (let j = 1; j < this._active.length; j++) {
            if (this._active[j][cwIdx] & mask) {
                for (let k = 0; k < targ.length; k++) this._active[j][k] ^= targ[k];
            }
        }
        for (const row of this._used) {
            if (row[cwIdx] & mask) for (let k = 0; k < targ.length; k++) row[k] ^= targ[k];
        }
        if (((this.b[cwIdx] & mask) !== 0) !== Boolean(value)) {
            for (let k = 0; k < this.b.length; k++) this.b[k] ^= targ[k];
        }
        this._used.push(targ);
        this._active.shift();
        return true;
    }

    get dataBytes() { return this.b.slice(0, this.nd); }
}

// ─────────────────────── Block layout helpers ──────────────────────────────────

function buildBlockLayout(version, eccLevel) {
    const info = computeBlockInfo(version, eccLevel);
    return {
        dataBlockLens: info.dataBlockLens,
        eccPerBlock: info.eccPerBlock,
        totalBlocks: info.totalBlocks
    };
}

// Compute contiguous GJ-accessible capacity at the end of the deinterleaved
// block-order ECC string. This supports the public decode rule:
// final byte = length, preceding length bytes = reversed secret.
function calcEccCapacity(dataBlockLens, lockBytes, eccPerBlock) {
    let total = 0;
    let seqOffset = 0;
    const perBlock = [];
    for (const blkLen of dataBlockLens) {
        const lockInBlock = Math.max(0, Math.min(lockBytes - seqOffset, blkLen));
        const freeInBlock = blkLen - lockInBlock;
        perBlock.push(Math.min(freeInBlock, eccPerBlock));
        seqOffset += blkLen;
    }
    for (let i = perBlock.length - 1; i >= 0; i--) {
        total += perBlock[i];
        if (perBlock[i] < eccPerBlock) break;
    }
    return total;
}

function buildEccPayloadPlan(dataBlockLens, lockBytes, eccPerBlock) {
    let seqOffset = 0;
    return dataBlockLens.map((blkLen, blockIndex) => {
        const start = seqOffset;
        const lockInBlock = Math.max(0, Math.min(lockBytes - start, blkLen));
        const freeInBlock = blkLen - lockInBlock;
        seqOffset += blkLen;
        return {
            blockIndex,
            start,
            length: blkLen,
            lockBytesInBlock: lockInBlock,
            payloadBytes: Math.min(freeInBlock, eccPerBlock)
        };
    });
}

function buildFunctionModules(version) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => Array.from({ length: size }, () => false));

    const placeFinder = (x0, y0) => {
        for (let dy = 0; dy < 7; dy++) {
            for (let dx = 0; dx < 7; dx++) {
                const xx = x0 + dx, yy = y0 + dy;
                const border = dx === 0 || dx === 6 || dy === 0 || dy === 6;
                const center = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
                modules[yy][xx] = border || center;
            }
        }
    };
    placeFinder(0, 0);
    placeFinder(size - 7, 0);
    placeFinder(0, size - 7);

    for (let i = 8; i < size - 8; i++) {
        modules[6][i] = i % 2 === 0;
        modules[i][6] = i % 2 === 0;
    }

    const centers = QRParser.getAlignmentPatternCenters(version);
    centers.forEach((cy) => {
        centers.forEach((cx) => {
            if (Math.abs(cx - 6) <= 4 && Math.abs(cy - 6) <= 4) return;
            if (Math.abs(cx - (size - 7)) <= 4 && cy <= 8) return;
            if (cx <= 8 && Math.abs(cy - (size - 7)) <= 4) return;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    const xx = cx + dx, yy = cy + dy;
                    const border = Math.abs(dx) === 2 || Math.abs(dy) === 2;
                    const center = dx === 0 && dy === 0;
                    modules[yy][xx] = border || center;
                }
            }
        });
    });

    modules[size - 8][8] = true;
    return modules;
}

function formatBitsValue(eccLevel, mask) {
    const eccMap = { L: 1, M: 0, Q: 3, H: 2 };
    const data = ((eccMap[eccLevel] || 0) << 3) | (mask & 7);
    let code = data << 10;
    for (let i = 14; i >= 10; i--) {
        if ((code >> i) & 1) code ^= 0x537 << (i - 10);
    }
    return ((data << 10) | code) ^ 0x5412;
}

function versionBitsValue(version) {
    let code = version << 12;
    for (let i = 17; i >= 12; i--) {
        if ((code >> i) & 1) code ^= 0x1f25 << (i - 12);
    }
    return (version << 12) | code;
}

function applyFormatAndVersion(modules, version, eccLevel, mask) {
    const size = modules.length;
    const fmt = formatBitsValue(eccLevel, mask);
    const fmtBits = [];
    for (let i = 14; i >= 0; i--) fmtBits.push((fmt >> i) & 1);

    const coordsA = [
        [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
        [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
    ];
    const coordsB = [
        [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8],
        [size - 5, 8], [size - 6, 8], [size - 7, 8],
        [8, size - 8], [8, size - 7], [8, size - 6], [8, size - 5],
        [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1]
    ];
    coordsA.forEach((c, i) => modules[c[1]][c[0]] = !!fmtBits[i]);
    coordsB.forEach((c, i) => modules[c[1]][c[0]] = !!fmtBits[i]);

    if (version >= 7) {
        const ver = versionBitsValue(version);
        for (let i = 0; i < 18; i++) {
            const bit = ((ver >> i) & 1) !== 0;
            const r = Math.floor(i / 3);
            const c = i % 3;
            modules[r][size - 11 + c] = bit;
            modules[size - 11 + c][r] = bit;
        }
    }
    return modules;
}

// Find smallest version where all data fits and ECC secret (if any) fits in GJ capacity.
function pickVersion(decoy, paddingSecret, eccSecret, eccLevel, maxVersion = 10) {
    const decoyBytes = utf8Bytes(decoy);
    const padSecretBytes = utf8Bytes(paddingSecret);
    const eccSecretBytes = utf8Bytes(eccSecret);

    for (let v = 1; v <= maxVersion; v++) {
        try {
            const blockInfo = computeBlockInfo(v, eccLevel);
            const padInfo = calcPadCapacity(decoyBytes.length, v, blockInfo.dataCodewords);
            const needPad = padSecretBytes.length > 0 ? padSecretBytes.length + 1 : 0;
            if (needPad > padInfo.padBytesCapacity) continue;

            const lockBytes = padInfo.padStart / 8 + (padSecretBytes.length > 0 ? 1 + padSecretBytes.length : 0);
            const eccCap = calcEccCapacity(blockInfo.dataBlockLens, lockBytes, blockInfo.eccPerBlock);
            if (eccSecretBytes.length + 1 > eccCap) continue; // +1 for length suffix

            return { version: v, padCapacity: padInfo.padBytesCapacity, eccCapacity: eccCap };
        } catch (e) {
            continue;
        }
    }
    return null;
}

const QRStego = {
    computeLayout(version, eccLevel) {
        return buildBlockLayout(version, eccLevel);
    },


    /**
     * Encode a stego QR code using Gauss-Jordan ECC manipulation.
     * The QR is 100% valid — ECC bytes are legitimately computed from padding.
     */
    async encodeStego(options) {
        const {
            decoy = '',
            paddingSecret = '',
            eccSecret = '',
            version = 5,
            eccLevel = 'H',
            mask = 0,
            autoVersion = false,
            maxVersion = 10
        } = options;

        if (typeof qrcodegen === 'undefined' || !qrcodegen.QrCode) {
            throw new Error('qrcodegen library not loaded');
        }

        const level = eccLevel.toUpperCase();
        let chosenVersion = version;

        if (autoVersion) {
            const plan = pickVersion(decoy, paddingSecret, eccSecret || '', level, maxVersion);
            if (!plan) {
                throw new Error('Too much data: no version <=10 fits with current secrets.');
            }
            chosenVersion = plan.version;
        }

        const eccMap = {
            L: qrcodegen.QrCode.Ecc.LOW,
            M: qrcodegen.QrCode.Ecc.MEDIUM,
            Q: qrcodegen.QrCode.Ecc.QUARTILE,
            H: qrcodegen.QrCode.Ecc.HIGH
        };
        const ecc = eccMap[level];
        if (!ecc) throw new Error('Invalid ECC level');

        const blockInfo = computeBlockInfo(chosenVersion, level);
        const dataBuild = buildDataCodewords(decoy, paddingSecret, chosenVersion, level);

        // Compute lock bytes: decoy header + padding secret (both must be preserved)
        const decoyBytes = utf8Bytes(decoy);
        const padInfo = calcPadCapacity(decoyBytes.length, chosenVersion, blockInfo.dataCodewords);
        const padSecretBytes = utf8Bytes(paddingSecret);
        const lockBytes = padInfo.padStart / 8 + (padSecretBytes.length > 0 ? 1 + padSecretBytes.length : 0);

        // Compute GJ-accessible ECC capacity
        const eccCap = calcEccCapacity(blockInfo.dataBlockLens, lockBytes, blockInfo.eccPerBlock);

        let dataCodewords = dataBuild.dataCodewords;

        if (eccSecret && eccSecret.length > 0) {
            const eccSecretBytes = utf8Bytes(eccSecret);
            // +1 for the trailing length byte.
            if (eccSecretBytes.length + 1 > eccCap) {
                throw new Error(
                    `ECC secret too long: need ${eccSecretBytes.length + 1} bytes (including 1-byte length suffix), ` +
                    `have ${eccCap} bytes capacity (${blockInfo.totalBlocks} block(s) × ${blockInfo.eccPerBlock} ECC bytes).`
                );
            }

            // Suffix payload over the deinterleaved ECC block-order string:
            // [...reversed(secret bytes), len]. This lets solvers read the final
            // ECC byte as a length, then reverse the preceding bytes.
            const eccPayload = new Uint8Array([...Array.from(eccSecretBytes).reverse(), eccSecretBytes.length]);

            let secretOffset = 0;
            const solvedBlocks = new Array(blockInfo.dataBlockLens.length);
            const payloadPlan = buildEccPayloadPlan(
                blockInfo.dataBlockLens,
                lockBytes,
                blockInfo.eccPerBlock
            );

            for (let planIdx = payloadPlan.length - 1; planIdx >= 0; planIdx--) {
                const blockPlan = payloadPlan[planIdx];
                const blkData = dataCodewords.slice(blockPlan.start, blockPlan.start + blockPlan.length);

                const payloadInBlock = Math.min(blockPlan.payloadBytes, eccPayload.length - secretOffset);

                if (payloadInBlock > 0) {
                    const gj = new GJBlock(blkData, blockInfo.eccPerBlock);

                    for (let bit = 0; bit < blockPlan.lockBytesInBlock * 8; bit++) {
                        gj.lockBit(bit);
                    }

                    let failures = 0;
                    const eccStart = blockInfo.eccPerBlock - payloadInBlock;
                    const payloadStart = eccPayload.length - secretOffset - payloadInBlock;
                    for (let byteIdx = 0; byteIdx < payloadInBlock; byteIdx++) {
                        const payloadByte = eccPayload[payloadStart + byteIdx];
                        for (let bitIdx = 0; bitIdx < 8; bitIdx++) {
                            const target = (payloadByte >> (7 - bitIdx)) & 1;
                            if (!gj.setEccBit(eccStart + byteIdx, bitIdx, target)) failures++;
                        }
                    }
                    if (failures > 0) {
                        console.warn(`GJBlock: ${failures} ECC bits could not be set (insufficient free bits)`);
                    }
                    secretOffset += payloadInBlock;

                    solvedBlocks[blockPlan.blockIndex] = gj.dataBytes;
                } else {
                    solvedBlocks[blockPlan.blockIndex] = blkData;
                }
            }

            dataCodewords = solvedBlocks.flat();
        }

        // qrcodegen recomputes ECC from the solved data bytes
        const qr = new qrcodegen.QrCode(chosenVersion, ecc, dataCodewords, mask);
        const canvas = drawModules(qr.modules);

        return {
            canvas,
            dataUrl: canvas.toDataURL('image/png'),
            padCapacity: dataBuild.padBytesCapacity,
            eccCapacity: eccCap,
            version: chosenVersion
        };
    },

    /**
     * Decode a QR code and extract hidden messages.
     * Accepts a ZXing BitMatrix (perspective-corrected module grid) so no
     * pixel re-sampling is needed — the module values are exact.
     */
    async decode(options) {
        const {
            bitMatrix,
            rawBytes = null,
            rawModules = null,
            nativeMeta = null,
            expectedText = '',
            extractPadding = true,
            extractECC = true,
            sampleCanvas = null,
            sampleTransform = null
        } = options;

        let qrData;
        const hasRawModules = Array.isArray(rawModules) && rawModules.length;

        if (bitMatrix || hasRawModules) {
            let modules;

            if (hasRawModules) {
                // Real module grid — whether from ZXing's CapturingGridSampler or from
                // sampling the native scanner's rectified crop (see
                // sampleModulesFromRectifiedImage) — needs no bitMatrix at all.
                modules = rawModules.map(row => Array.from(row, Boolean));
            } else {
                const size = bitMatrix.getWidth();
                if (sampleCanvas && sampleTransform) {
                    // Direct pixel sampling matches the dot overlay exactly, avoiding
                    // HybridBinarizer's adaptive thresholding which can misclassify
                    // ECC-region modules while still letting ZXing correct the data region.
                    // Threshold and polarity come from the finder patterns, not a fixed
                    // luma cut, so low-contrast and color-inverted codes sample correctly.
                    const ctx = sampleCanvas.getContext('2d');
                    const w = sampleCanvas.width, h = sampleCanvas.height;
                    const imgData = ctx.getImageData(0, 0, w, h);
                    const readLuma = (col, row) => {
                        const pts = new Float32Array([col + 0.5, row + 0.5]);
                        sampleTransform.transformPoints(pts);
                        const px = Math.round(pts[0]);
                        const py = Math.round(pts[1]);
                        if (px < 0 || px >= w || py < 0 || py >= h) return NaN;
                        const i = (py * w + px) * 4;
                        return (imgData.data[i] + imgData.data[i + 1] + imgData.data[i + 2]) / 3;
                    };
                    const { threshold, invert } = calibrateModulePolarity(readLuma, size);
                    modules = [];
                    for (let row = 0; row < size; row++) {
                        modules[row] = [];
                        for (let col = 0; col < size; col++) {
                            const luma = readLuma(col, row);
                            modules[row][col] = Number.isFinite(luma) && ((luma < threshold) !== invert);
                        }
                    }
                } else {
                    // Fallback: use ZXing's BitMatrix directly
                    modules = [];
                    for (let row = 0; row < size; row++) {
                        modules[row] = [];
                        for (let col = 0; col < size; col++) {
                            modules[row][col] = bitMatrix.get(col, row);
                        }
                    }
                }
            }

            try {
                qrData = QRParser.parseBest(modules, expectedText);
                QRParser.trimQuietZone(modules);
            } catch (e) {
                console.error('QR parsing failed:', e);
                qrData = {
                    version: 5, size: 37, eccLevel: 'H', mask: 0,
                    dataCodewords: [], eccCodewords: [], eccSpec: null
                };
            }
        } else if (nativeMeta && nativeMeta.version && nativeMeta.eccLevel && rawBytes && rawBytes.length) {
            // Native (Vision) path: no module grid available. VNBarcodeObservation's
            // CIQRCodeDescriptor gives us symbolVersion/maskPattern/errorCorrectionLevel
            // directly, and errorCorrectedPayload is the deinterleaved *data* codeword
            // stream per ISO/IEC 18004 §6.4.10 (i.e. exactly qrData.dataCodewords) — but
            // it does not include the ECC codewords, so ECC-based hiding/error-counting
            // stays unavailable here (eccCodewords: [] makes those steps below no-op).
            qrData = {
                version: nativeMeta.version,
                size: nativeMeta.version * 4 + 17,
                eccLevel: nativeMeta.eccLevel,
                mask: typeof nativeMeta.mask === 'number' ? nativeMeta.mask : null,
                dataCodewords: Array.from(rawBytes),
                eccCodewords: []
            };
        } else {
            throw new Error('decode() requires a bitMatrix or native version/eccLevel metadata');
        }

        // rawBytes are the decoder's RS-corrected data codewords (ZXing's
        // getRawBytes / Vision's errorCorrectedPayload). Our own module sampling
        // is independent of the decoder's and can misread modules it handled fine;
        // such errors corrupt the segment header and hide padding secrets even
        // though the QR scanned cleanly. When the corrected stream is available,
        // adopt it and recompute the true ECC from it.
        let knownErrors = null;
        let errorsUnknown = false;
        try {
            if (rawBytes && rawBytes.length && qrData.version) {
                // Match the corrected stream against the parsed ECC level first.
                // If the lengths disagree, scan the other levels: data-codeword
                // counts are unique per level for a given version, so the length
                // of the corrected stream pins down the true level even when a
                // glossy/engraved/low-contrast code makes the sampled format
                // info unreadable and the grid parses under the wrong level.
                let blockInfo = null;
                let eccLevelOverridden = false;
                for (const level of [qrData.eccLevel, 'L', 'M', 'Q', 'H']) {
                    if (!level) continue;
                    try {
                        const candidate = computeBlockInfo(qrData.version, level);
                        if (candidate.dataCodewords === rawBytes.length) {
                            blockInfo = candidate;
                            eccLevelOverridden = level !== qrData.eccLevel;
                            if (eccLevelOverridden) qrData.eccLevel = level;
                            break;
                        }
                    } catch (_) { /* level table missing for this version */ }
                }

                if (blockInfo) {
                    const corrected = Array.from(rawBytes, b => b & 0xFF);
                    const sampled = qrData.dataCodewords || [];
                    const sampledEcc = qrData.eccCodewords || [];

                    if (!eccLevelOverridden && sampled.length === corrected.length && sampledEcc.length) {
                        // Independently sampled grid under the right level: report
                        // the exact number of damaged codewords — data bytes that
                        // differ from the corrected stream, plus ECC bytes that
                        // differ from RS(data).
                        let dataErrors = 0;
                        for (let i = 0; i < corrected.length; i++) {
                            if (sampled[i] !== corrected[i]) dataErrors++;
                        }
                        knownErrors = dataErrors +
                            (countEccMismatches(corrected, sampledEcc, blockInfo) || 0);
                    } else {
                        // Misparsed grid, wrong-level parse, or no grid at all:
                        // the corrected bytes are authoritative but there is no
                        // valid sampled stream to diff against, so the physical
                        // error count is unknown.
                        errorsUnknown = true;
                    }

                    qrData.dataCodewords = corrected;
                    qrData.eccCodewords = recomputeBlockEcc(corrected, blockInfo);
                }
            }
        } catch (_) {
            // correction bookkeeping failed — keep the sampled stream as-is
        }

        // Compute where message data ends and QR padding bytes (0xEC/0x11) begin.
        // Delegates to the mode-aware segment walker so numeric/alphanumeric/kanji
        // QR codes resolve correctly, not just byte mode.
        function _paddingOffset(data, version) {
            if (!data || data.length === 0) return 0;
            const padStart = QRParser.findPaddingStart(data, version);
            return padStart >= 0 ? padStart : data.length;
        }

        const result = {
            version: qrData.version,
            size: qrData.size,
            eccLevel: qrData.eccLevel,
            mask: qrData.mask,
            paddingSecret: null,
            eccSecret: null,
            errorsFound: null,
            dataCodewords: qrData.dataCodewords ? Array.from(qrData.dataCodewords) : [],
            eccCodewords:  qrData.eccCodewords  ? Array.from(qrData.eccCodewords)  : [],
            paddingOffset: _paddingOffset(qrData.dataCodewords, qrData.version)
        };

        try {
            if (knownErrors !== null) {
                // Exact damaged-codeword count from comparing the sampled grid
                // against the decoder's corrected stream — works even when the
                // damage exceeds what Berlekamp-Massey alone could attribute.
                result.errorsFound = knownErrors;
            } else if (errorsUnknown) {
                // ECC was synthesized from corrected data (no sampled grid, or a
                // wrong-level parse), so a BM pass would always report 0 — the
                // true error count is unknown.
                result.errorsFound = null;
            } else if (qrData.version && qrData.eccLevel && qrData.dataCodewords?.length && qrData.eccCodewords?.length) {
                const blockInfo = computeBlockInfo(qrData.version, qrData.eccLevel);
                result.errorsFound = countCorrectableCodewordErrors(
                    qrData.dataCodewords, qrData.eccCodewords, blockInfo
                );
            }
        } catch (e) {
            result.errorsFound = null;
        }

        if (extractPadding) {
            try {
                result.paddingSecret = '';

                if (!result.paddingSecret && qrData.dataCodewords && qrData.dataCodewords.length > 0) {
                    result.paddingSecret = QRParser.extractPaddingSecret(qrData.dataCodewords, qrData.version) || '';
                }
            } catch (e) {
                console.error('Padding extraction failed:', e);
                result.paddingSecret = '';
            }
        }

        if (extractECC && qrData.eccCodewords && qrData.eccCodewords.length > 0) {
            try {
                const blockInfo = computeBlockInfo(qrData.version, qrData.eccLevel);
                const eccCodewords = qrData.eccCodewords;
                // Suffix format over deinterleaved ECC bytes in block order:
                // final byte = length; previous length bytes = reversed secret.

                const secretLen = eccCodewords[eccCodewords.length - 1];
                if (secretLen > 0 && 1 + secretLen <= eccCodewords.length) {
                    try {
                        const reversedSecret = eccCodewords
                            .slice(eccCodewords.length - 1 - secretLen, eccCodewords.length - 1)
                            .reverse();
                        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(
                            new Uint8Array(reversedSecret)
                        );
                        const isPrintable = [...decoded].every(ch => {
                            const cp = ch.codePointAt(0);
                            return cp >= 0x20 || cp === 0x09 || cp === 0x0A || cp === 0x0D;
                        });
                        result.eccSecret = isPrintable ? decoded : '';
                    } catch (e) {
                        result.eccSecret = '';
                    }
                } else {
                    result.eccSecret = '';
                }
            } catch (e) {
                console.error('ECC extraction failed:', e);
                result.eccSecret = '';
            }
        }

        return result;
    },

    /**
     * Rebuilds the module grid from the native (Vision) scanner's rectified QR crop.
     * The crop is already a straight-on, 1:1 image of the symbol (Swift used
     * CIPerspectiveCorrection against Vision's own corner points), so this just reads
     * each module's center pixel — no further perspective transform is needed here.
     */
    async sampleModulesFromRectifiedImage(dataUrl, moduleCount) {
        const img = await new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => reject(new Error('Failed to load rectified QR image'));
            image.src = dataUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const w = canvas.width, h = canvas.height;
        const imgData = ctx.getImageData(0, 0, w, h).data;

        const cellW = w / moduleCount;
        const cellH = h / moduleCount;
        const readLuma = (col, row) => {
            const px = Math.min(w - 1, Math.floor((col + 0.5) * cellW));
            const py = Math.min(h - 1, Math.floor((row + 0.5) * cellH));
            const i = (py * w + px) * 4;
            return (imgData[i] + imgData[i + 1] + imgData[i + 2]) / 3;
        };
        // Finder-calibrated threshold/polarity — see calibrateModulePolarity.
        const { threshold, invert } = calibrateModulePolarity(readLuma, moduleCount);
        const modules = [];
        for (let row = 0; row < moduleCount; row++) {
            modules[row] = [];
            for (let col = 0; col < moduleCount; col++) {
                modules[row][col] = (readLuma(col, row) < threshold) !== invert;
            }
        }
        return modules;
    },

};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = QRStego;
}
