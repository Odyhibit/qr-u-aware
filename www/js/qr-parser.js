// QR Code Structure Parser
// Extracts raw data and ECC bytes from QR codes

const QRParser = {
    // QR specifications
    VERSION_INFO: {
        1: {
            size: 21,
            totalCodewords: 26,
            ecBlocks: {
                'L': { blocks: 1, dataPerBlock: 19, eccPerBlock: 7 },
                'M': { blocks: 1, dataPerBlock: 16, eccPerBlock: 10 },
                'Q': { blocks: 1, dataPerBlock: 13, eccPerBlock: 13 },
                'H': { blocks: 1, dataPerBlock: 9, eccPerBlock: 17 }
            }
        },
        2: {
            size: 25,
            totalCodewords: 44,
            ecBlocks: {
                'L': { blocks: 1, dataPerBlock: 34, eccPerBlock: 10 },
                'M': { blocks: 1, dataPerBlock: 28, eccPerBlock: 16 },
                'Q': { blocks: 1, dataPerBlock: 22, eccPerBlock: 22 },
                'H': { blocks: 1, dataPerBlock: 16, eccPerBlock: 28 }
            }
        },
        3: {
            size: 29,
            totalCodewords: 70,
            ecBlocks: {
                'L': { blocks: 1, dataPerBlock: 55, eccPerBlock: 15 },
                'M': { blocks: 1, dataPerBlock: 44, eccPerBlock: 26 },
                'Q': { blocks: 2, dataPerBlock: 17, eccPerBlock: 18 },
                'H': { blocks: 2, dataPerBlock: 13, eccPerBlock: 22 }
            }
        },
        4: {
            size: 33,
            totalCodewords: 100,
            ecBlocks: {
                'L': { blocks: 1, dataPerBlock: 80, eccPerBlock: 20 },
                'M': { blocks: 2, dataPerBlock: 32, eccPerBlock: 18 },
                'Q': { blocks: 2, dataPerBlock: 24, eccPerBlock: 26 },
                'H': { blocks: 4, dataPerBlock: 9, eccPerBlock: 16 }
            }
        },
        5: {
            size: 37,
            totalCodewords: 134,
            ecBlocks: {
                'L': { blocks: 1, dataPerBlock: 108, eccPerBlock: 26 },
                'M': { blocks: 2, dataPerBlock: 43, eccPerBlock: 24 },
                'Q': { blocks: 2, dataPerBlock: 15, eccPerBlock: 18, numShort: 2, dataPerBlock2: 16 },
                'H': { blocks: 4, dataPerBlock: 11, eccPerBlock: 22, numShort: 2, dataPerBlock2: 12 }
            }
        },
        6: {
            size: 41,
            totalCodewords: 172,
            ecBlocks: {
                'L': { blocks: 2, dataPerBlock: 68, eccPerBlock: 18 },
                'M': { blocks: 4, dataPerBlock: 27, eccPerBlock: 16 },
                'Q': { blocks: 4, dataPerBlock: 19, eccPerBlock: 24 },
                'H': { blocks: 4, dataPerBlock: 15, eccPerBlock: 28 }
            }
        },
        7: {
            size: 45,
            totalCodewords: 196,
            ecBlocks: {
                'L': { blocks: 2, dataPerBlock: 78, eccPerBlock: 20 },
                'M': { blocks: 4, dataPerBlock: 31, eccPerBlock: 18 },
                'Q': { blocks: 2, dataPerBlock: 14, eccPerBlock: 18, blocks2: 4, dataPerBlock2: 15, eccPerBlock2: 18 },
                'H': { blocks: 4, dataPerBlock: 13, eccPerBlock: 26, blocks2: 1, dataPerBlock2: 14, eccPerBlock2: 26 }
            }
        },
        8: {
            size: 49,
            totalCodewords: 242,
            ecBlocks: {
                'L': { blocks: 2, dataPerBlock: 97, eccPerBlock: 24 },
                'M': { blocks: 2, dataPerBlock: 38, eccPerBlock: 22, blocks2: 2, dataPerBlock2: 39, eccPerBlock2: 22 },
                'Q': { blocks: 4, dataPerBlock: 18, eccPerBlock: 22, blocks2: 2, dataPerBlock2: 19, eccPerBlock2: 22 },
                'H': { blocks: 4, dataPerBlock: 14, eccPerBlock: 26, blocks2: 2, dataPerBlock2: 15, eccPerBlock2: 26 }
            }
        },
        9: {
            size: 53,
            totalCodewords: 292,
            ecBlocks: {
                'L': { blocks: 2, dataPerBlock: 116, eccPerBlock: 30 },
                'M': { blocks: 3, dataPerBlock: 36, eccPerBlock: 22, blocks2: 2, dataPerBlock2: 37, eccPerBlock2: 22 },
                'Q': { blocks: 4, dataPerBlock: 16, eccPerBlock: 20, blocks2: 4, dataPerBlock2: 17, eccPerBlock2: 20 },
                'H': { blocks: 4, dataPerBlock: 12, eccPerBlock: 24, blocks2: 4, dataPerBlock2: 13, eccPerBlock2: 24 }
            }
        },
        10: {
            size: 57,
            totalCodewords: 346,
            ecBlocks: {
                'L': { blocks: 2, dataPerBlock: 68, eccPerBlock: 18, blocks2: 2, dataPerBlock2: 69, eccPerBlock2: 18 },
                'M': { blocks: 4, dataPerBlock: 43, eccPerBlock: 26, blocks2: 1, dataPerBlock2: 44, eccPerBlock2: 26 },
                'Q': { blocks: 6, dataPerBlock: 19, eccPerBlock: 24, blocks2: 2, dataPerBlock2: 20, eccPerBlock2: 24 },
                'H': { blocks: 6, dataPerBlock: 15, eccPerBlock: 28, blocks2: 2, dataPerBlock2: 16, eccPerBlock2: 28 }
            }
        }
    },

    /**
     * Parse QR code from a pre-detected boolean module grid and extract all codewords.
     * The modules array comes from ZXing's perspective-corrected BitMatrix so no
     * pixel sampling is needed here.
     */
    parse(modules) {

        if (!modules || !modules.length) {
            throw new Error('No module grid provided');
        }

        // Read format information
        const formatInfo = this.readFormatInfo(modules);
        const version = this.detectVersion(modules.length);

        const blockSpec = this.getBlockSpec(version, formatInfo.eccLevel);

        // Extract raw bits from QR code
        const bits = this.extractDataBits(modules, version, formatInfo.mask);

        // Convert bits to bytes (codewords)
        const codewords = this.bitsToBytes(bits).slice(0, blockSpec.totalCodewords);

        // Deinterleave data codewords (handling mixed sizes)
        const dataCodewords = this.deinterleaveMixed(
            codewords.slice(0, blockSpec.totalDataBytes),
            blockSpec.numShortBlocks,
            blockSpec.shortDataSize,
            blockSpec.numLongBlocks,
            blockSpec.longDataSize
        );

        // Deinterleave ECC codewords
        const eccCodewords = this.deinterleave(
            codewords.slice(blockSpec.totalDataBytes, blockSpec.totalCodewords),
            blockSpec.totalBlocks,
            blockSpec.eccPerBlock
        );

        return {
            version,
            size: modules.length,
            eccLevel: formatInfo.eccLevel,
            mask: formatInfo.mask,
            modules,
            dataCodewords,
            eccCodewords,
            eccSpec: {
                blocks: blockSpec.totalBlocks,
                dataPerBlock: blockSpec.shortDataSize,
                dataPerBlock2: blockSpec.longDataSize,
                eccPerBlock: blockSpec.eccPerBlock,
                numShort: blockSpec.numShortBlocks,
                dataBlockLens: blockSpec.dataBlockLens
            },
            formatErrors: formatInfo.errors || 0
        };
    },

    parseWithMetadata(modules, version, eccLevel, mask, formatErrors = 0) {
        const blockSpec = this.getBlockSpec(version, eccLevel);
        const bits = this.extractDataBits(modules, version, mask);
        const codewords = this.bitsToBytes(bits).slice(0, blockSpec.totalCodewords);
        const dataCodewords = this.deinterleaveMixed(
            codewords.slice(0, blockSpec.totalDataBytes),
            blockSpec.numShortBlocks,
            blockSpec.shortDataSize,
            blockSpec.numLongBlocks,
            blockSpec.longDataSize
        );
        const eccCodewords = this.deinterleave(
            codewords.slice(blockSpec.totalDataBytes, blockSpec.totalCodewords),
            blockSpec.totalBlocks,
            blockSpec.eccPerBlock
        );

        return {
            version,
            size: modules.length,
            eccLevel,
            mask,
            modules,
            dataCodewords,
            eccCodewords,
            eccSpec: {
                blocks: blockSpec.totalBlocks,
                dataPerBlock: blockSpec.shortDataSize,
                dataPerBlock2: blockSpec.longDataSize,
                eccPerBlock: blockSpec.eccPerBlock,
                numShort: blockSpec.numShortBlocks,
                dataBlockLens: blockSpec.dataBlockLens
            },
            formatErrors
        };
    },

    /**
     * ZXing gives us the same sampled grid it decoded, but the grid can be
     * rotated or mirrored. Try every QR symmetry and choose the one whose
     * byte-mode payload matches ZXing's decoded text.
     */
    parseBest(modules, expectedText = '') {
        const normalizedModules = this.trimQuietZone(modules);
        const expectedBytes = this.stringToBytes(expectedText);

        const buildCandidates = (name, candidateModules) => {
            try {
                const formatInfo = this.readFormatInfo(candidateModules);
                const mirrorCheck = this.checkMirroredFormat(candidateModules);
                const version = this.detectVersion(candidateModules.length);
                const results = [];

                const formatIsReliable = (formatInfo.errors || 0) <= 3;
                const tryAlternates = !formatIsReliable;
                const eccLevels = tryAlternates ? ['L', 'M', 'Q', 'H'] : [formatInfo.eccLevel];
                const masks = tryAlternates ? [0, 1, 2, 3, 4, 5, 6, 7] : [formatInfo.mask];

                for (const eccLevel of eccLevels) {
                    for (const mask of masks) {
                        const parsed = this.parseWithMetadata(
                            candidateModules,
                            version,
                            eccLevel,
                            mask,
                            eccLevel === formatInfo.eccLevel && mask === formatInfo.mask ? formatInfo.errors || 0 : 10
                        );
                        parsed.orientation = name;
                        parsed.finderScore = this.finderOrientationScore(candidateModules);
                        parsed.formatMirrorCheck = mirrorCheck;
                        parsed.score = this.scoreParseCandidate(parsed, expectedBytes);
                        parsed.score += parsed.finderScore * 10000;
                        if (mirrorCheck.looksMirrored && !name.includes('mirror')) {
                            parsed.score += 1000000;
                        } else if (!mirrorCheck.looksMirrored && name.includes('mirror')) {
                            parsed.score += 5000;
                        }
                        if ((eccLevel !== formatInfo.eccLevel || mask !== formatInfo.mask)) {
                            parsed.score += formatIsReliable ? 2000 : 1000;
                        }
                        results.push(parsed);
                    }
                }
                return { formatInfo, results };
            } catch (e) {
                return { formatInfo: null, results: [] };
            }
        };

        const canonical = buildCandidates('rotate0', normalizedModules);
        const canonicalResults = canonical.results.sort((a, b) => a.score - b.score);
        const canonicalMirrorCheck = canonicalResults[0]?.formatMirrorCheck || null;
        if (
            canonical.formatInfo &&
            (canonical.formatInfo.errors || 0) <= 3 &&
            canonicalMirrorCheck &&
            canonicalMirrorCheck.forwardErrors === 0 &&
            !canonicalMirrorCheck.looksMirrored &&
            canonicalResults.length
        ) {
            return canonicalResults[0];
        }

        const transformCandidates = this.moduleTransforms(normalizedModules)
            .filter(({ name }) => name !== 'rotate0')
            .flatMap(({ name, modules: candidateModules }) => buildCandidates(name, candidateModules).results)
            .concat(canonicalResults);

        const candidates = transformCandidates.sort((a, b) => a.score - b.score);

        if (!candidates.length) {
            throw new Error('Could not parse QR module grid in any orientation');
        }
        return candidates[0];
    },

    checkMirroredFormat(modules) {
        const copies = this.readFormatCopies(modules);
        const reversedPrimary = this.decodeFormatInt(this.reverseBits(copies.primary.raw, 15));
        const reversedSecondary = this.decodeFormatInt(this.reverseBits(copies.secondary.raw, 15));
        const forwardErrors = Math.min(copies.primary.decoded.errors, copies.secondary.decoded.errors);
        const reverseErrors = Math.min(reversedPrimary.errors, reversedSecondary.errors);

        return {
            forwardErrors,
            reverseErrors,
            looksMirrored: forwardErrors > 0 && reverseErrors === 0,
            reversedPrimary,
            reversedSecondary
        };
    },

    reverseBits(value, width) {
        let out = 0;
        for (let i = 0; i < width; i++) {
            out = (out << 1) | ((value >> i) & 1);
        }
        return out;
    },

    finderOrientationScore(modules) {
        const scores = this.finderCornerScores(modules);
        if (!scores) return 999;

        const required = scores.tl + scores.tr + scores.bl;
        const missingCornerPenalty = scores.br < Math.max(scores.tl, scores.tr, scores.bl) ? 25 : 0;
        return required + missingCornerPenalty;
    },

    finderCornerScores(modules) {
        const size = modules.length;
        if (size < 21) return null;

        const FINDER = [
            [1,1,1,1,1,1,1],
            [1,0,0,0,0,0,1],
            [1,0,1,1,1,0,1],
            [1,0,1,1,1,0,1],
            [1,0,1,1,1,0,1],
            [1,0,0,0,0,0,1],
            [1,1,1,1,1,1,1]
        ];
        const s = size - 1;

        const score = (r0, c0, dr, dc) => {
            let mismatches = 0;
            for (let r = 0; r < 7; r++) {
                for (let c = 0; c < 7; c++) {
                    if (((modules[r0 + r * dr]?.[c0 + c * dc]) ? 1 : 0) !== FINDER[r][c]) {
                        mismatches++;
                    }
                }
            }
            return mismatches;
        };

        return {
            tl: score(0, 0, 1, 1),
            tr: score(0, s, 1, -1),
            bl: score(s, 0, -1, 1),
            br: score(s, s, -1, -1)
        };
    },

    trimQuietZone(modules) {
        const size = modules.length;
        let minX = size, minY = size, maxX = -1, maxY = -1;

        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (modules[y][x]) {
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                }
            }
        }

        if (maxX < minX || maxY < minY) return modules;

        const trimmedSize = maxX - minX + 1;
        if (trimmedSize !== maxY - minY + 1 || trimmedSize < 21 || (trimmedSize - 17) % 4 !== 0) {
            return modules;
        }

        if (trimmedSize === size) return modules;

        return Array.from({ length: trimmedSize }, (_, y) =>
            modules[minY + y].slice(minX, maxX + 1)
        );
    },

    /**
     * Returns true if the module grid has inverted polarity (light/dark swapped),
     * as happens with raised-metal or etched QR codes where the "dark" module
     * reflects more light than the background.
     *
     * Checks the three finder-pattern corners in both polarities; whichever
     * polarity gives a lower total mismatch score is the correct one.
     * Only called BEFORE detectRotation so rotation is resolved on correct polarity.
     */
    isInverted(modules) {
        const size = modules.length;
        if (size < 21) return false;
        const FINDER = [
            [1,1,1,1,1,1,1],
            [1,0,0,0,0,0,1],
            [1,0,1,1,1,0,1],
            [1,0,1,1,1,0,1],
            [1,0,1,1,1,0,1],
            [1,0,0,0,0,0,1],
            [1,1,1,1,1,1,1]
        ];
        const s = size - 1;
        const score = (r0, c0, dr, dc, inv) => {
            let m = 0;
            for (let r = 0; r < 7; r++)
                for (let c = 0; c < 7; c++) {
                    const mod = ((modules[r0 + r*dr]?.[c0 + c*dc]) ? 1 : 0) ^ (inv ? 1 : 0);
                    if (mod !== FINDER[r][c]) m++;
                }
            return m;
        };
        const normal   = score(0,0,1,1,false) + score(0,s,1,-1,false) + score(s,0,-1,1,false);
        const inverted = score(0,0,1,1,true)  + score(0,s,1,-1,true)  + score(s,0,-1,1,true);
        return inverted < normal;
    },

    /**
     * Determine how many 90° CW rotations are needed to bring modules into
     * standard QR orientation (finder patterns at TL, TR, BL; empty at BR).
     *
     * Call isInverted() and correct polarity BEFORE calling this, so the
     * finder pattern scores are reliable. Returns 0, 1, 2, or 3.
     */
    detectRotation(modules) {
        const size = modules.length;
        if (size < 21) return 0;

        const FINDER = [
            [1,1,1,1,1,1,1],
            [1,0,0,0,0,0,1],
            [1,0,1,1,1,0,1],
            [1,0,1,1,1,0,1],
            [1,0,1,1,1,0,1],
            [1,0,0,0,0,0,1],
            [1,1,1,1,1,1,1]
        ];
        const s = size - 1;

        const score = (r0, c0, dr, dc) => {
            let m = 0;
            for (let r = 0; r < 7; r++)
                for (let c = 0; c < 7; c++)
                    if (((modules[r0 + r*dr]?.[c0 + c*dc]) ? 1 : 0) !== FINDER[r][c]) m++;
            return m;
        };

        const tl = score(0, 0,  1,  1);
        const tr = score(0, s,  1, -1);
        const bl = score(s, 0, -1,  1);
        const br = score(s, s, -1, -1);

        const worst = Math.max(tl, tr, bl, br);
        if (br === worst) return 0;
        if (bl === worst) return 3;
        if (tl === worst) return 2;
        return 1; // tr is worst
    },

    moduleTransforms(modules) {
        const rotate90 = (m) => {
            const size = m.length;
            return Array.from({ length: size }, (_, y) =>
                Array.from({ length: size }, (_, x) => m[size - 1 - x][y])
            );
        };
        const mirrorHorizontal = (m) => m.map(row => row.slice().reverse());
        const transforms = [];
        let rotated = modules;
        for (let i = 0; i < 4; i++) {
            transforms.push({ name: `rotate${i * 90}`, modules: rotated });
            transforms.push({ name: `rotate${i * 90}-mirror`, modules: mirrorHorizontal(rotated) });
            rotated = rotate90(rotated);
        }
        return transforms;
    },

    scoreParseCandidate(parsed, expectedBytes) {
        let score = (parsed.formatErrors || 0) * 100;
        const payload = this.readByteModePayload(parsed.dataCodewords, parsed.version);
        const codewordErrors = this.countCorrectableCodewordErrors(parsed);
        parsed.codewordErrors = codewordErrors;

        if (codewordErrors === null) {
            score += 50000;
        } else {
            score += codewordErrors * 1000;
        }

        if ((payload.mode === 4 || payload.mode === 7) && !payload.validCount) score += 500;

        if ((payload.mode === 4 || payload.mode === 7) && expectedBytes.length > 0) {
            score += Math.abs(payload.count - expectedBytes.length) * 50;
            if (payload.bytes.length >= expectedBytes.length) {
                let mismatches = 0;
                for (let i = 0; i < expectedBytes.length; i++) {
                    if (payload.bytes[i] !== expectedBytes[i]) mismatches++;
                }
                score += mismatches * 200;
                if (mismatches === 0 && payload.count === expectedBytes.length) score -= 10000;
            } else {
                score += 10000;
            }
        }

        return score;
    },

    _gfInit() {
        if (this._gfExp && this._gfLog) return;
        this._gfExp = new Uint8Array(512);
        this._gfLog = new Uint8Array(256);
        let x = 1;
        for (let i = 0; i < 255; i++) {
            this._gfExp[i] = x;
            this._gfExp[i + 255] = x;
            this._gfLog[x] = i;
            x = ((x << 1) ^ (x & 0x80 ? 0x1D : 0)) & 0xFF;
        }
    },

    _gfMul(a, b) {
        this._gfInit();
        return (a === 0 || b === 0) ? 0 : this._gfExp[this._gfLog[a] + this._gfLog[b]];
    },

    _gfDiv(a, b) {
        this._gfInit();
        if (b === 0) throw new Error('GF division by zero');
        return a === 0 ? 0 : this._gfExp[(this._gfLog[a] - this._gfLog[b] + 255) % 255];
    },

    _rsSyndromes(codewords, eccLen) {
        this._gfInit();
        const syndromes = [];
        for (let i = 0; i < eccLen; i++) {
            const x = this._gfExp[i];
            let y = 0;
            for (const b of codewords) {
                y = this._gfMul(y, x) ^ b;
            }
            syndromes.push(y);
        }
        return syndromes;
    },

    _rsErrorCountForBlock(dataBlock, eccBlock, eccLen) {
        const syndromes = this._rsSyndromes([...dataBlock, ...eccBlock], eccLen);
        if (syndromes.every(v => v === 0)) return 0;

        let c = [1];
        let b = [1];
        let l = 0;
        let m = 1;
        let bb = 1;

        for (let n = 0; n < eccLen; n++) {
            let d = syndromes[n];
            for (let i = 1; i <= l; i++) {
                d ^= this._gfMul(c[i] || 0, syndromes[n - i]);
            }

            if (d === 0) {
                m++;
                continue;
            }

            const t = c.slice();
            const coef = this._gfDiv(d, bb);
            for (let i = 0; i < b.length; i++) {
                c[i + m] = (c[i + m] || 0) ^ this._gfMul(coef, b[i]);
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

        return l <= Math.floor(eccLen / 2) ? l : null;
    },

    countCorrectableCodewordErrors(parsed) {
        if (!parsed?.dataCodewords?.length || !parsed?.eccCodewords?.length) return null;

        const spec = parsed.eccSpec || this.getBlockSpec(parsed.version, parsed.eccLevel);
        let dataOff = 0;
        let eccOff = 0;
        let total = 0;

        for (const dLen of spec.dataBlockLens) {
            const dataBlock = parsed.dataCodewords.slice(dataOff, dataOff + dLen);
            const eccBlock = parsed.eccCodewords.slice(eccOff, eccOff + spec.eccPerBlock);
            const count = this._rsErrorCountForBlock(dataBlock, eccBlock, spec.eccPerBlock);
            if (count === null) return null;
            total += count;
            dataOff += dLen;
            eccOff += spec.eccPerBlock;
        }

        return total;
    },

    countEccMismatches(parsed) {
        if (!parsed?.dataCodewords?.length || !parsed?.eccCodewords?.length) return null;
        if (typeof qrcodegen === 'undefined' || !qrcodegen.QrCode) return null;

        const spec = parsed.eccSpec || this.getBlockSpec(parsed.version, parsed.eccLevel);
        const divisor = qrcodegen.QrCode.reedSolomonComputeDivisor(spec.eccPerBlock);
        let dataOff = 0;
        let eccOff = 0;
        let mismatches = 0;

        for (const dLen of spec.dataBlockLens) {
            const dataBlock = parsed.dataCodewords.slice(dataOff, dataOff + dLen);
            const expectedEcc = qrcodegen.QrCode.reedSolomonComputeRemainder(dataBlock, divisor);
            for (let i = 0; i < spec.eccPerBlock; i++) {
                if (parsed.eccCodewords[eccOff + i] !== expectedEcc[i]) mismatches++;
            }
            dataOff += dLen;
            eccOff += spec.eccPerBlock;
        }

        return mismatches;
    },

    readByteModePayload(dataCodewords, version) {
        const ccBits = version <= 9 ? 8 : 16;
        const totalBits = dataCodewords.length * 8;
        const readBits = (start, length) => {
            let value = 0;
            for (let i = 0; i < length; i++) {
                const bitPos = start + i;
                value = (value << 1) | ((dataCodewords[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
            }
            return value;
        };

        if (totalBits < 4) {
            return { mode: 0, count: 0, bytes: [], validCount: false };
        }

        const mode = readBits(0, 4);

        if (mode === 7) {
            // ECI mode: skip 8-bit ECI designator (handles single-byte designators 0-127),
            // then expect a byte-mode segment immediately after.
            const offset0 = 12; // 4 (ECI indicator) + 8 (designator)
            if (totalBits >= offset0 + 4 + ccBits) {
                const innerMode = readBits(offset0, 4);
                if (innerMode === 4) {
                    const count = readBits(offset0 + 4, ccBits);
                    const payloadStart = offset0 + 4 + ccBits;
                    const validCount = payloadStart + count * 8 <= totalBits;
                    const bytes = [];
                    for (let i = 0; i < count && payloadStart + (i + 1) * 8 <= totalBits; i++) {
                        bytes.push(readBits(payloadStart + i * 8, 8));
                    }
                    return { mode: 7, count, bytes, validCount };
                }
            }
            return { mode: 7, count: 0, bytes: [], validCount: false };
        }

        if (totalBits < 4 + ccBits) {
            return { mode: 0, count: 0, bytes: [], validCount: false };
        }

        const count = readBits(4, ccBits);
        const payloadStart = 4 + ccBits;
        const validCount = payloadStart + count * 8 <= totalBits;
        const bytes = [];
        for (let i = 0; i < count && payloadStart + (i + 1) * 8 <= totalBits; i++) {
            bytes.push(readBits(payloadStart + i * 8, 8));
        }
        return { mode, count, bytes, validCount };
    },

    /**
     * Compute QR block layout from qrcodegen's spec tables.
     * This mirrors qrcodegen.addEccAndInterleave(), including the skipped
     * padding byte in short blocks.
     */
    getBlockSpec(version, eccLevel) {
        if (typeof qrcodegen === 'undefined' || !qrcodegen.QrCode) {
            const versionSpec = this.VERSION_INFO[version];
            if (!versionSpec || !versionSpec.ecBlocks[eccLevel]) {
                throw new Error(`QR version ${version} / ECC ${eccLevel} not supported`);
            }
            const legacy = versionSpec.ecBlocks[eccLevel];
            const totalBlocks = (legacy.blocks || 0) + (legacy.blocks2 || 0);
            const numShortBlocks = legacy.numShort !== undefined ? legacy.numShort : legacy.blocks;
            const numLongBlocks = totalBlocks - numShortBlocks;
            const shortDataSize = legacy.dataPerBlock;
            const longDataSize = legacy.dataPerBlock2 || shortDataSize;
            const eccPerBlock = legacy.eccPerBlock;
            return {
                totalBlocks,
                numShortBlocks,
                numLongBlocks,
                shortDataSize,
                longDataSize,
                eccPerBlock,
                totalDataBytes: numShortBlocks * shortDataSize + numLongBlocks * longDataSize,
                totalECCBytes: totalBlocks * eccPerBlock,
                totalCodewords: versionSpec.totalCodewords,
                dataBlockLens: [
                    ...Array(numShortBlocks).fill(shortDataSize),
                    ...Array(numLongBlocks).fill(longDataSize)
                ]
            };
        }

        const eccMap = {
            L: qrcodegen.QrCode.Ecc.LOW,
            M: qrcodegen.QrCode.Ecc.MEDIUM,
            Q: qrcodegen.QrCode.Ecc.QUARTILE,
            H: qrcodegen.QrCode.Ecc.HIGH
        };
        const ecc = eccMap[eccLevel];
        if (!ecc) throw new Error(`Invalid ECC ${eccLevel}`);

        const totalBlocks = qrcodegen.QrCode.NUM_ERROR_CORRECTION_BLOCKS[ecc.ordinal][version];
        const eccPerBlock = qrcodegen.QrCode.ECC_CODEWORDS_PER_BLOCK[ecc.ordinal][version];
        const totalCodewords = Math.floor(qrcodegen.QrCode.getNumRawDataModules(version) / 8);
        const totalDataBytes = qrcodegen.QrCode.getNumDataCodewords(version, ecc);
        const totalECCBytes = totalCodewords - totalDataBytes;
        const shortBlockLen = Math.floor(totalCodewords / totalBlocks);
        const numShortBlocks = totalBlocks - (totalCodewords % totalBlocks);
        const numLongBlocks = totalBlocks - numShortBlocks;
        const shortDataSize = shortBlockLen - eccPerBlock;
        const longDataSize = shortDataSize + 1;

        return {
            totalBlocks,
            numShortBlocks,
            numLongBlocks,
            shortDataSize,
            longDataSize,
            eccPerBlock,
            totalDataBytes,
            totalECCBytes,
            totalCodewords,
            dataBlockLens: [
                ...Array(numShortBlocks).fill(shortDataSize),
                ...Array(numLongBlocks).fill(longDataSize)
            ]
        };
    },

    /**
     * Detect QR modules from image
     */
    detectModules(imageData, location, knownVersion) {
        const { width, height, data } = imageData;

        let bounds;
        if (location) {
            // Use jsQR's detected corners — avoids findQRBounds picking up
            // unrelated dark pixels in the camera frame.
            const corners = [
                location.topLeftCorner,
                location.topRightCorner,
                location.bottomRightCorner,
                location.bottomLeftCorner
            ];
            bounds = {
                minX: Math.floor(Math.min(...corners.map(c => c.x))),
                maxX: Math.ceil(Math.max(...corners.map(c => c.x))),
                minY: Math.floor(Math.min(...corners.map(c => c.y))),
                maxY: Math.ceil(Math.max(...corners.map(c => c.y)))
            };
        } else {
            bounds = this.findQRBounds(data, width, height);
            if (!bounds) return null;
        }

        const qrWidth = bounds.maxX - bounds.minX + 1;
        const qrHeight = bounds.maxY - bounds.minY + 1;

        // Prefer the version reported by jsQR; fall back to pixel-ratio heuristic.
        let bestSize;
        if (knownVersion) {
            bestSize = knownVersion * 4 + 17;
        } else {
            let bestDiff = Infinity;
            bestSize = 21;
            for (let v = 1; v <= 10; v++) {
                const size = v * 4 + 17;
                const avg = (qrWidth / size + qrHeight / size) / 2;
                const diff = Math.abs(avg - Math.round(avg));
                if (diff < bestDiff) { bestDiff = diff; bestSize = size; }
            }
        }

        const moduleSize = (qrWidth / bestSize + qrHeight / bestSize) / 2;

        // Perspective-correct sampling: bilinear map from module (col,row) →
        // pixel using jsQR's four corners. Simple rectangular grid sampling
        // drifts badly under any camera angle; bilinear corrects for that.
        const usePerspective = location && location.topLeftCorner && location.topRightCorner &&
                               location.bottomLeftCorner && location.bottomRightCorner;
        const TL = usePerspective ? location.topLeftCorner     : { x: bounds.minX, y: bounds.minY };
        const TR = usePerspective ? location.topRightCorner    : { x: bounds.maxX, y: bounds.minY };
        const BL = usePerspective ? location.bottomLeftCorner  : { x: bounds.minX, y: bounds.maxY };
        const BR = usePerspective ? location.bottomRightCorner : { x: bounds.maxX, y: bounds.maxY };

        const modules = [];
        for (let row = 0; row < bestSize; row++) {
            modules[row] = [];
            const v = (row + 0.5) / bestSize;
            for (let col = 0; col < bestSize; col++) {
                const u = (col + 0.5) / bestSize;
                const px = Math.round((1-u)*(1-v)*TL.x + u*(1-v)*TR.x + (1-u)*v*BL.x + u*v*BR.x);
                const py = Math.round((1-u)*(1-v)*TL.y + u*(1-v)*TR.y + (1-u)*v*BL.y + u*v*BR.y);
                if (px < 0 || px >= width || py < 0 || py >= height) {
                    modules[row][col] = false;
                    continue;
                }
                const idx = (py * width + px) * 4;
                const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
                modules[row][col] = brightness < 128;
            }
        }

        return modules;
    },

    /**
     * Find QR code boundaries
     */
    findQRBounds(data, width, height) {
        let minX = width, maxX = 0, minY = height, maxY = 0;
        let found = false;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
                if (brightness < 200) {
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                    minY = Math.min(minY, y);
                    maxY = Math.max(maxY, y);
                    found = true;
                }
            }
        }

        return found ? { minX, maxX, minY, maxY } : null;
    },

    /**
     * Detect QR version from module count
     */
    detectVersion(size) {
        return Math.floor((size - 17) / 4);
    },

    /**
     * Read format information from QR code.
     * Reads both copies (primary near top-left, secondary near top-right/bottom-left)
     * and returns the result with fewest BCH errors.
     */
    readFormatInfo(modules) {
        const copies = this.readFormatCopies(modules);
        const r1 = copies.primary.decoded;
        const r2 = copies.secondary.decoded;
        const best = copies.dataAgree
            ? copies.dataDecoded
            : (r1.errors <= r2.errors ? r1 : r2);
        return Object.assign({}, best, { copies });
    },

    readFormatCopies(modules) {
        const size = modules.length;
        // Coordinates are [x,y,bitIndex]. QR format bits are placed LSB-first
        // around the finder patterns, so reconstruct the raw 15-bit word by
        // setting each bit at its actual index instead of shifting in scan order.
        let primary = 0;
        const primaryOrder = [
            [8,0,0],[8,1,1],[8,2,2],[8,3,3],[8,4,4],[8,5,5],[8,7,6],[8,8,7],
            [7,8,8],[5,8,9],[4,8,10],[3,8,11],[2,8,12],[1,8,13],[0,8,14]
        ];
        for (const [x, y, bit] of primaryOrder) {
            if (modules[y][x]) primary |= 1 << bit;
        }

        let sec = 0;
        const secondaryOrder = [
            [size-1,8,0],[size-2,8,1],[size-3,8,2],[size-4,8,3],
            [size-5,8,4],[size-6,8,5],[size-7,8,6],[size-8,8,7],
            [8,size-7,8],[8,size-6,9],[8,size-5,10],
            [8,size-4,11],[8,size-3,12],[8,size-2,13],[8,size-1,14]
        ];
        for (const [x, y, bit] of secondaryOrder) {
            if (modules[y][x]) sec |= 1 << bit;
        }

        const r1 = this.decodeFormatInt(primary);
        const r2 = this.decodeFormatInt(sec);
        const highData = raw => (raw >> 10) & 0x1F;
        const highBits = raw => highData(raw).toString(2).padStart(5, '0');
        const asBW = bits => bits.replace(/1/g, 'B').replace(/0/g, 'W');
        const decodeDataBits = data => {
            const unmasked = data ^ ((0x5412 >> 10) & 0x1F);
            const eccLevels = ['M','L','H','Q'];
            return {
                eccLevel: eccLevels[(unmasked >> 3) & 3],
                mask: unmasked & 7,
                errors: Math.min(r1.errors, r2.errors),
                dataBitsOnly: true
            };
        };
        const primaryData = highData(primary);
        const secondaryData = highData(sec);
        const dataAgree = primaryData === secondaryData;

        return {
            primary: {
                raw: primary,
                rawBits: primary.toString(2).padStart(15, '0'),
                dataBits: highBits(primary),
                modules: asBW(highBits(primary)),
                decoded: r1,
                dataDecoded: decodeDataBits(primaryData)
            },
            secondary: {
                raw: sec,
                rawBits: sec.toString(2).padStart(15, '0'),
                dataBits: highBits(sec),
                modules: asBW(highBits(sec)),
                decoded: r2,
                dataDecoded: decodeDataBits(secondaryData)
            },
            agree: r1.eccLevel === r2.eccLevel && r1.mask === r2.mask,
            dataAgree,
            dataDecoded: dataAgree ? decodeDataBits(primaryData) : null,
            best: r1.errors <= r2.errors ? 'primary' : 'secondary'
        };
    },

    // BCH remainder for QR format info (generator 0x537)
    _formatBCH(val) {
        let v = val;
        for (let i = 14; i >= 10; i--) {
            if ((v >> i) & 1) v ^= (0x537 << (i - 10));
        }
        return v & 0x3FF;
    },

    // Build the valid 15-bit BCH codeword for a 5-bit data value
    _formatCodeword(data) {
        let bch = data << 10;
        for (let i = 14; i >= 10; i--) {
            if ((bch >> i) & 1) bch ^= (0x537 << (i - 10));
        }
        return (data << 10) | (bch & 0x3FF);
    },

    /**
     * Decode a raw 15-bit format int using minimum-distance BCH.
     * Tries all 32 valid format strings and returns the closest match.
     */
    decodeFormatInt(rawInt) {
        const unmasked = rawInt ^ 0x5412;

        // Fast path: if BCH remainder is 0 it's already valid
        if (this._formatBCH(unmasked) === 0) {
            const data = (unmasked >> 10) & 0x1F;
            const eccLevels = ['M','L','H','Q'];
            return { eccLevel: eccLevels[(data >> 3) & 3], mask: data & 7, errors: 0 };
        }

        // Minimum Hamming distance over all 32 valid codewords
        let bestDist = 16, bestData = 0;
        for (let data = 0; data < 32; data++) {
            const candidate = this._formatCodeword(data) ^ 0x5412;
            let diff = rawInt ^ candidate, dist = 0;
            while (diff) { dist += diff & 1; diff >>>= 1; }
            if (dist < bestDist) { bestDist = dist; bestData = data; }
        }

        const eccLevels = ['M','L','H','Q'];
        return {
            eccLevel: eccLevels[(bestData >> 3) & 3],
            mask: bestData & 7,
            errors: bestDist
        };
    },

    // Keep old entry point name for any other callers
    decodeFormatInfo(bits) {
        let raw = 0;
        for (let i = 0; i < 15; i++) raw = (raw << 1) | bits[i];
        const r = this.decodeFormatInt(raw);
        return { eccLevel: r.eccLevel, mask: r.mask };
    },

    /**
     * Extract data bits from QR code following the zigzag pattern
     */
    extractDataBits(modules, version, mask) {
        const size = modules.length;
        const bits = [];

        // QR codes read data in columns from right to left, alternating up/down
        let upward = true;

        for (let col = size - 1; col > 0; col -= 2) {
            if (col === 6) col--; // Skip timing column

            for (let row = 0; row < size; row++) {
                const y = upward ? (size - 1 - row) : row;

                // Read two columns
                for (let c = 0; c < 2; c++) {
                    const x = col - c;

                    // Skip function patterns
                    if (this.isFunctionPattern(x, y, size, version)) continue;

                    // Read bit and unmask
                    let bit = modules[y][x] ? 1 : 0;
                    if (this.shouldUnmask(x, y, mask)) {
                        bit = bit ^ 1;
                    }

                    bits.push(bit);
                }
            }

            upward = !upward;
        }

        return bits;
    },

    /**
     * Check if position is part of a function pattern (finder, timing, alignment, etc.)
     */
    isFunctionPattern(x, y, size, version) {
        // Finder patterns (corners)
        if ((x < 9 && y < 9) ||  // Top-left
            (x < 9 && y >= size - 8) ||  // Bottom-left
            (x >= size - 8 && y < 9)) {  // Top-right
            return true;
        }

        // Timing patterns
        if (x === 6 || y === 6) return true;

        // Dark module
        if (x === 8 && y === size - 8) return true;

        // Version information areas (versions 7+): two 6×3 blocks
        if (version >= 7 &&
            ((x >= size - 11 && x <= size - 9 && y < 6) ||
             (y >= size - 11 && y <= size - 9 && x < 6))) {
            return true;
        }

        // Alignment patterns
        const alignmentCenters = this.getAlignmentPatternCenters(version);
        for (let cy of alignmentCenters) {
            for (let cx of alignmentCenters) {
                // Skip if overlaps with finder patterns
                if ((cx < 10 && cy < 10) ||
                    (cx < 10 && cy >= size - 9) ||
                    (cx >= size - 9 && cy < 10)) {
                    continue;
                }
                // Check if (x,y) is within 5×5 alignment pattern centered at (cx, cy)
                if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) {
                    return true;
                }
            }
        }

        return false;
    },

    /**
     * Get alignment pattern center coordinates for a version
     */
    getAlignmentPatternCenters(version) {
        if (version === 1) return [];
        // Simplified - only handling versions 2-10
        const positions = {
            2: [6, 18],
            3: [6, 22],
            4: [6, 26],
            5: [6, 30],
            6: [6, 34],
            7: [6, 22, 38],
            8: [6, 24, 42],
            9: [6, 26, 46],
            10: [6, 28, 50],
            11: [6, 30, 54],
            12: [6, 32, 58],
            13: [6, 34, 62],
            14: [6, 26, 46, 66],
            15: [6, 26, 48, 70],
            16: [6, 26, 50, 74],
            17: [6, 30, 54, 78],
            18: [6, 30, 56, 82],
            19: [6, 30, 58, 86],
            20: [6, 34, 62, 90],
            21: [6, 28, 50, 72, 94],
            22: [6, 26, 50, 74, 98],
            23: [6, 30, 54, 78, 102],
            24: [6, 28, 54, 80, 106],
            25: [6, 32, 58, 84, 110],
            26: [6, 30, 58, 86, 114],
            27: [6, 34, 62, 90, 118],
            28: [6, 26, 50, 74, 98, 122],
            29: [6, 30, 54, 78, 102, 126],
            30: [6, 26, 52, 78, 104, 130],
            31: [6, 30, 56, 82, 108, 134],
            32: [6, 34, 60, 86, 112, 138],
            33: [6, 30, 58, 86, 114, 142],
            34: [6, 34, 62, 90, 118, 146],
            35: [6, 30, 54, 78, 102, 126, 150],
            36: [6, 24, 50, 76, 102, 128, 154],
            37: [6, 28, 54, 80, 106, 132, 158],
            38: [6, 32, 58, 84, 110, 136, 162],
            39: [6, 26, 54, 82, 110, 138, 166],
            40: [6, 30, 58, 86, 114, 142, 170]
        };
        return positions[version] || [];
    },

    /**
     * Check if position should be unmasked
     */
    shouldUnmask(x, y, mask) {
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
    },

    /**
     * Convert bits to bytes
     */
    bitsToBytes(bits) {
        const bytes = [];
        for (let i = 0; i < bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8 && i + j < bits.length; j++) {
                byte = (byte << 1) | bits[i + j];
            }
            bytes.push(byte);
        }
        return bytes;
    },

    /**
     * Deinterleave codewords
     * Interleaved format: B0[0], B1[0], B2[0], B3[0], B0[1], B1[1], ...
     * Output: B0[0], B0[1], ..., B1[0], B1[1], ..., etc.
     */
    deinterleave(codewords, numBlocks, bytesPerBlock) {
        const blocks = Array.from({ length: numBlocks }, () => []);

        // Deinterleave by distributing bytes to blocks
        for (let i = 0; i < bytesPerBlock; i++) {
            for (let block = 0; block < numBlocks; block++) {
                const idx = i * numBlocks + block;
                if (idx < codewords.length) {
                    blocks[block].push(codewords[idx]);
                }
            }
        }

        // Concatenate all blocks
        return blocks.flat();
    },

    /**
     * Deinterleave codewords with mixed block sizes
     * Some blocks are "short" and some are "long" (1 byte longer)
     */
    deinterleaveMixed(codewords, numShort, shortSize, numLong, longSize) {
        const totalBlocks = numShort + numLong;
        const blocks = Array.from({ length: totalBlocks }, () => []);

        // Interleaving pattern:
        // First shortSize bytes: all blocks contribute
        // Last byte: only long blocks contribute

        let pos = 0;

        // Phase 1: All blocks (up to shortSize)
        for (let i = 0; i < shortSize; i++) {
            for (let block = 0; block < totalBlocks; block++) {
                if (pos < codewords.length) {
                    blocks[block].push(codewords[pos++]);
                }
            }
        }

        // Phase 2: Only long blocks (the extra byte)
        if (longSize > shortSize) {
            for (let block = numShort; block < totalBlocks; block++) {
                if (pos < codewords.length) {
                    blocks[block].push(codewords[pos++]);
                }
            }
        }

        // Concatenate all blocks
        return blocks.flat();
    },

    /**
     * Walk the data-codeword bit stream segment by segment to find where message
     * data ends and padding begins. Handles every standard segment type — numeric,
     * alphanumeric, byte, kanji, ECI, FNC1, structured append — not just byte mode,
     * so QR codes from ordinary generators (which pick numeric/alphanumeric for
     * plain text) resolve to the correct padding offset too.
     * Returns the padding start byte index, or -1 if the stream doesn't parse.
     */
    findPaddingStart(dataCodewords, version) {
        if (!dataCodewords || dataCodewords.length === 0) return -1;
        const capacityBits = dataCodewords.length * 8;
        let pos = 0;
        const readBits = (n) => {
            let v = 0;
            for (let i = 0; i < n; i++, pos++) {
                v = (v << 1) | ((dataCodewords[pos >> 3] >> (7 - (pos & 7))) & 1);
            }
            return v;
        };
        const ccBitsIdx = version <= 9 ? 0 : version <= 26 ? 1 : 2;
        const ccBitsFor = { 1: [10, 12, 14], 2: [9, 11, 13], 4: [8, 16, 16], 8: [8, 10, 12] };

        for (let guard = 0; guard < 64; guard++) {
            if (pos + 4 > capacityBits) { pos = capacityBits; break; }
            const mode = readBits(4);
            if (mode === 0) break; // terminator
            if (mode === 7) {      // ECI: 1/2/3-byte designator, then next segment
                if (pos + 8 > capacityBits) return -1;
                const b0 = readBits(8);
                const extra = (b0 & 0x80) === 0 ? 0 : (b0 & 0xC0) === 0x80 ? 8 : (b0 & 0xE0) === 0xC0 ? 16 : -1;
                if (extra < 0 || pos + extra > capacityBits) return -1;
                readBits(extra);
                continue;
            }
            if (mode === 5) continue; // FNC1 first position — no payload
            if (mode === 9) {         // FNC1 second position — 8-bit application indicator
                if (pos + 8 > capacityBits) return -1;
                readBits(8);
                continue;
            }
            if (mode === 3) {         // structured append — 4b index + 4b total + 8b parity
                if (pos + 16 > capacityBits) return -1;
                readBits(16);
                continue;
            }

            const ccTable = ccBitsFor[mode];
            if (!ccTable) return -1; // unknown mode — stream is not valid QR data
            const ccBits = ccTable[ccBitsIdx];
            if (pos + ccBits > capacityBits) return -1;
            const count = readBits(ccBits);
            let dataBits;
            switch (mode) {
                case 1: dataBits = Math.floor(count / 3) * 10 + [0, 4, 7][count % 3]; break;
                case 2: dataBits = Math.floor(count / 2) * 11 + (count % 2) * 6; break;
                case 4: dataBits = count * 8; break;
                case 8: dataBits = count * 13; break;
            }
            if (pos + dataBits > capacityBits) return -1;
            pos += dataBits;
        }

        // Byte-align past the terminator; everything after is padding.
        const padStartBit = pos + (((-pos % 8) + 8) % 8);
        return Math.min(padStartBit / 8, dataCodewords.length);
    },

    /**
     * Extract padding secret from data codewords. Two hiding formats are checked:
     * 1. Length-prefixed: [len][secret bytes][standard 0xEC/0x11 fill]
     * 2. Raw overwrite: message bytes written straight over the 0xEC/0x11 fill
     */
    extractPaddingSecret(dataCodewords, version = 5) {
        const padByteStart = this.findPaddingStart(dataCodewords, version);
        if (padByteStart < 0 || padByteStart >= dataCodewords.length) return '';
        const padding = dataCodewords.slice(padByteStart);

        // Format 1: 1-byte length prefix, secret, then spec fill bytes
        const secretLen = padding[0];
        if (secretLen > 0 && 1 + secretLen <= padding.length) {
            const secretStr = this.bytesToString(padding.slice(1, 1 + secretLen));
            if (secretStr && this._isStandardFill(padding, 1 + secretLen)) return secretStr;
        }

        // Format 2: no prefix — strip the trailing spec fill (a valid 0xEC/0x11
        // alternation in either phase, since an overwrite preserves the original
        // absolute phase while a re-encode restarts it) and read what's left.
        let end = padding.length;
        while (end > 0) {
            const b = padding[end - 1];
            if (b !== 0xEC && b !== 0x11) break;
            if (end < padding.length && b === padding[end]) break; // must alternate
            end--;
        }
        if (end === 0) return ''; // padding is exactly per spec — nothing hidden
        return this.bytesToString(padding.slice(0, end)) || '';
    },

    // True when padding[offset..] is the spec-mandated fill: 0xEC/0x11 strictly
    // alternating, in either phase (encoders differ on whether the alternation
    // restarts after a hidden payload or keeps the original phase).
    _isStandardFill(padding, offset) {
        for (let i = offset; i < padding.length; i++) {
            const b = padding[i];
            if (b !== 0xEC && b !== 0x11) return false;
            if (i > offset && b === padding[i - 1]) return false;
        }
        return true;
    },

    /**
     * Extract ECC secret from ECC codewords
     */
    extractECCSecret(eccCodewords, kPerBlock, numBlocks, eccPerBlock) {
        // Suffix format over deinterleaved ECC bytes in block order:
        // final byte = length; previous length bytes = reversed secret.

        if (eccCodewords.length >= 1) {
            const length = eccCodewords[eccCodewords.length - 1];
            if (length > 0 && 1 + length <= eccCodewords.length && length < 255) {
                const secret = eccCodewords
                    .slice(eccCodewords.length - 1 - length, eccCodewords.length - 1)
                    .reverse();
                const secretStr = this.bytesToString(secret);
                return secretStr;
            }
        }

        return '';
    },

    /**
     * Convert bytes to string
     */
    bytesToString(bytes) {
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
        } catch (e) {
            return '';
        }
    },

    stringToBytes(str) {
        if (!str) return [];
        try {
            return Array.from(new TextEncoder().encode(str));
        } catch (e) {
            return Array.from(str).map(ch => ch.charCodeAt(0) & 0xFF);
        }
    }
};
