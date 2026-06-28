// QR Code Steganography Decoder/Encoder Module (GJ-based approach)
//
// Hides a message in ECC bytes by solving for padding values that produce
// the desired ECC output. The QR is 100% valid — no bytes are overwritten.

// ── Reed-Solomon encoder for ECC difference counting ─────────────────────────
// GF(256) with primitive polynomial 0x011D (same field used by QR codes).
// We re-encode each data block and compare the computed ECC to the stored ECC.
// Differing bytes = ECC bytes that were modified from what the data produces.

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

// Count codewords (data + ECC) that differ from the correctly-decoded content.
// rawDataStream = ZXing's corrected data bytes in physical/interleaved order
// (same order the QR zigzag produces before block deinterleaving).
// dataCodewords from QRParser is already deinterleaved into block order, so we
// must deinterleave rawDataStream to match before comparing byte-by-byte.
// physicalCW: raw codeword bytes in QR zigzag order (data then ECC, all interleaved)
// rawDataStream: ZXing-corrected data in sequential (block-contiguous) order:
//   Block0[0..n0-1], Block1[0..n1-1], ...  (the encoded bit stream, NOT interleaved)
// blockInfo: from computeBlockInfo — { dataCodewords, totalBlocks, eccPerBlock, dataBlockLens }
function countQrErrors(physicalCW, rawDataStream, blockInfo) {
    if (!physicalCW?.length || !rawDataStream?.length || !blockInfo) return null;

    const { dataCodewords: totalData, totalBlocks, eccPerBlock, dataBlockLens } = blockInfo;

    // Split rawDataStream sequentially into per-block arrays.
    // rawDataStream is the encoded bit stream: Block0 bytes come first, then Block1, etc.
    const blockData = [];
    let seqOff = 0;
    for (const dLen of dataBlockLens) {
        blockData.push(rawDataStream.slice(seqOff, seqOff + dLen));
        seqOff += dLen;
    }

    const shortLen = dataBlockLens[0];
    const numShort = dataBlockLens.filter(l => l === shortLen).length;
    const numLong  = totalBlocks - numShort;

    let errors = 0;

    // Data comparison: re-interleave blockData to physical order, compare against physicalCW.
    // Phase 1: first shortLen bytes of every block, round-robin across all blocks
    let physPos = 0;
    for (let i = 0; i < shortLen; i++) {
        for (let b = 0; b < totalBlocks; b++) {
            if (physPos < physicalCW.length) {
                if (physicalCW[physPos] !== blockData[b][i]) errors++;
                physPos++;
            }
        }
    }
    // Phase 2: the extra byte of each long block (long blocks only)
    if (numLong > 0) {
        for (let b = numShort; b < totalBlocks; b++) {
            if (physPos < physicalCW.length) {
                if (physicalCW[physPos] !== blockData[b][shortLen]) errors++;
                physPos++;
            }
        }
    }

    // ECC comparison: compute correct ECC per block, compare against physical ECC positions.
    // ECC is always interleaved round-robin: physical[totalData + j*totalBlocks + b] = ecc_b[j]
    for (let b = 0; b < totalBlocks; b++) {
        const cleanEcc = _computeEcc(new Uint8Array(blockData[b]), eccPerBlock);
        for (let j = 0; j < eccPerBlock; j++) {
            const physIdx = totalData + j * totalBlocks + b;
            if (physIdx < physicalCW.length && physicalCW[physIdx] !== cleanEcc[j]) errors++;
        }
    }

    return errors;
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
            expectedText = '',
            extractPadding = true,
            extractECC = true,
            sampleCanvas = null,
            sampleTransform = null
        } = options;

        if (!bitMatrix) throw new Error('decode() requires a bitMatrix');

        const size = bitMatrix.getWidth();
        let modules;

        if (sampleCanvas && sampleTransform) {
            // Direct pixel sampling matches the dot overlay exactly (luma < 128),
            // avoiding HybridBinarizer's adaptive thresholding which can misclassify
            // ECC-region modules while still letting ZXing correct the data region.
            const ctx = sampleCanvas.getContext('2d');
            const w = sampleCanvas.width, h = sampleCanvas.height;
            const imgData = ctx.getImageData(0, 0, w, h);
            modules = [];
            for (let row = 0; row < size; row++) {
                modules[row] = [];
                for (let col = 0; col < size; col++) {
                    const pts = new Float32Array([col + 0.5, row + 0.5]);
                    sampleTransform.transformPoints(pts);
                    const px = Math.round(pts[0]);
                    const py = Math.round(pts[1]);
                    if (px < 0 || px >= w || py < 0 || py >= h) {
                        modules[row][col] = false;
                    } else {
                        const i = (py * w + px) * 4;
                        const luma = (imgData.data[i] + imgData.data[i + 1] + imgData.data[i + 2]) / 3;
                        modules[row][col] = luma < 128;
                    }
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

        let qrData = null;
        let trimmedModules = null;
        try {
            qrData = QRParser.parseBest(modules, expectedText);

            // parseBest may choose a non-canonical orientation for ECI QRs because
            // ECI mode (nibble 0111) fails the byte-mode check, making all eight
            // candidates score the same 10000 penalty and leaving format-error count
            // as the tiebreaker — which can pick the wrong rotation.
            // ZXing's bitMatrix is always in the correct orientation, so re-extract
            // data/ECC in rotate0 using the version/eccLevel/mask parseBest detected.
            try {
                trimmedModules = QRParser.trimQuietZone(modules);
                const r0 = QRParser.parseWithMetadata(
                    trimmedModules, qrData.version, qrData.eccLevel, qrData.mask, qrData.formatErrors || 0
                );
                qrData = Object.assign({}, qrData, {
                    dataCodewords: r0.dataCodewords,
                    eccCodewords:  r0.eccCodewords
                });
            } catch (_) { /* keep parseBest result */ }
        } catch (e) {
            console.error('QR parsing failed:', e);
            qrData = {
                version: 5, size: 37, eccLevel: 'H', mask: 0,
                dataCodewords: [], eccCodewords: [], eccSpec: null
            };
        }

        // Compute where message data ends and QR padding bytes (0xEC/0x11) begin.
        // Formula mirrors QRParser.extractPaddingSecret: mode(4b) + cc(8b for v≤9, 16b otherwise) + data bytes
        function _paddingOffset(data, version) {
            if (!data || data.length === 0) return 0;
            const ccBits = version <= 9 ? 8 : 16;
            const firstByte = data[0];
            let decoyLen;
            if (ccBits === 8) {
                const count_msb = firstByte & 0x0F;
                const count_lsb = (data[1] >> 4) & 0x0F;
                decoyLen = (count_msb << 4) | count_lsb;
            } else {
                decoyLen = ((data[1] & 0x0F) << 8) | data[2];
            }
            const capacityBits = data.length * 8;
            const usedBits = 4 + ccBits + 8 * decoyLen;
            const termBits = Math.min(4, capacityBits - usedBits);
            const afterTerm = usedBits + termBits;
            const padStartBit = afterTerm + ((-afterTerm) % 8);
            return Math.min(Math.floor(padStartBit / 8), data.length);
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
            // rawDataStream: ZXing's ECC-corrected sequential data codewords (Block0 then Block1 …).
            // Populated from rawBytes when available; falls back to building from decoded text.
            let rawDataStream = rawBytes?.length ? Array.from(rawBytes) : null;
            if (!rawDataStream && expectedText) {
                try {
                    const bi = computeBlockInfo(qrData.version, qrData.eccLevel);
                    const built = _buildCleanDataCodewords(
                        Array.from(utf8Bytes(expectedText)), qrData.version, bi.dataCodewords, null
                    );
                    if (built) rawDataStream = Array.from(built);
                } catch (_) { /* leave rawDataStream null */ }
            }
            if (rawDataStream && qrData.version && qrData.eccLevel) {
                // Prefer the blockInfo whose dataCodewords matches rawDataStream.length —
                // ZXing's parse of format info is more reliable than ours (it uses BCH
                // error correction), so rawDataStream.length is the authoritative ECC-level
                // indicator when our parseBest disagrees (e.g. polished/inverted QR coins).
                let blockInfo = computeBlockInfo(qrData.version, qrData.eccLevel);
                if (blockInfo.dataCodewords !== rawDataStream.length) {
                    for (const lvl of ['L', 'M', 'Q', 'H']) {
                        const bi = computeBlockInfo(qrData.version, lvl);
                        if (bi.dataCodewords === rawDataStream.length) {
                            blockInfo = bi;
                            result.eccLevel = lvl;
                            break;
                        }
                    }
                }

                // ZXing's BitMatrixParser.readCodewords() unmasks the bitMatrix in-place before
                // reading, so bitMatrix.get() already returns unmasked bit values by the time
                // our decode() runs. Build physicalCW directly from that unmasked bitMatrix so
                // the comparison uses the same binarization as rawDataStream, eliminating false
                // errors from the luma-threshold vs HybridBinarizer disagreement in the overlay area.
                // mask=8 falls through to default:return false in shouldUnmask → no second unmask.
                const bmSize = bitMatrix.getWidth();
                const bmMods = Array.from({ length: bmSize }, (_, r) =>
                    Array.from({ length: bmSize }, (_, c) => bitMatrix.get(c, r))
                );
                const bmTrimmed = QRParser.trimQuietZone(bmMods);
                const bits = QRParser.extractDataBits(bmTrimmed, qrData.version, 8);
                const totalCW = blockInfo.dataCodewords + blockInfo.eccPerBlock * blockInfo.totalBlocks;
                const physicalCW = QRParser.bitsToBytes(bits).slice(0, totalCW);
                // ZXing sometimes decodes via InvertedLuminanceSource (light-on-dark QR codes),
                // which causes every data bit in lastBits to be flipped after in-place unmasking.
                // Try both polarities and take the lower error count — the coin QR case gives 0
                // errors on the inverted attempt; a normal QR gives 0 on the normal attempt.
                const errN = countQrErrors(physicalCW, rawDataStream, blockInfo);
                const errI = countQrErrors(physicalCW.map(b => (~b) & 0xFF), rawDataStream, blockInfo);
                result.errorsFound = (errN !== null && errI !== null) ? Math.min(errN, errI)
                    : errN ?? errI;
            }
        } catch (e) {
            result.errorsFound = null;
        }

        if (extractPadding) {
            try {
                const zxingDataCodewords = rawBytes ? Array.from(rawBytes) : [];
                result.paddingSecret = '';

                if (zxingDataCodewords.length > 0) {
                    result.paddingSecret = QRParser.extractPaddingSecret(zxingDataCodewords, qrData.version) || '';
                }

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

                result.eccDebug = {
                    eccCodewords: Array.from(eccCodewords),
                    eccPerBlock: blockInfo.eccPerBlock,
                    dataBlockLens: [...blockInfo.dataBlockLens],
                    secretLengthByte: eccCodewords[eccCodewords.length - 1]
                };

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

};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = QRStego;
}
