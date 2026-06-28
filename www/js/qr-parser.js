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
        console.log('[Parse] Starting QR parse...');

        if (!modules || !modules.length) {
            throw new Error('No module grid provided');
        }

        console.log(`[Parse] Received ${modules.length}×${modules.length} module grid`);

        // Read format information
        const formatInfo = this.readFormatInfo(modules);
        const version = this.detectVersion(modules.length);

        console.log(`[Parse] Version: ${version}, ECC: ${formatInfo.eccLevel}, Mask: ${formatInfo.mask}`);

        const blockSpec = this.getBlockSpec(version, formatInfo.eccLevel);
        console.log(`[Parse] Spec: ${blockSpec.totalBlocks} blocks, ${blockSpec.shortDataSize}/${blockSpec.longDataSize} data bytes/block, ${blockSpec.eccPerBlock} ECC bytes/block`);

        // Extract raw bits from QR code
        const bits = this.extractDataBits(modules, version, formatInfo.mask);
        console.log(`[Parse] Extracted ${bits.length} bits`);

        // Convert bits to bytes (codewords)
        const codewords = this.bitsToBytes(bits).slice(0, blockSpec.totalCodewords);
        console.log(`[Parse] Converted to ${codewords.length} codewords`);
        console.log(`[Parse] First 20 codewords:`, codewords.slice(0, 20));

        console.log(`[Parse] Splitting: ${blockSpec.totalDataBytes} data bytes (${blockSpec.numShortBlocks}×${blockSpec.shortDataSize} + ${blockSpec.numLongBlocks}×${blockSpec.longDataSize}), ${blockSpec.totalECCBytes} ECC bytes`);
        console.log(`[Parse] Interleaved data ends at position ${blockSpec.totalDataBytes}`);

        // Deinterleave data codewords (handling mixed sizes)
        const dataCodewords = this.deinterleaveMixed(
            codewords.slice(0, blockSpec.totalDataBytes),
            blockSpec.numShortBlocks,
            blockSpec.shortDataSize,
            blockSpec.numLongBlocks,
            blockSpec.longDataSize
        );

        console.log(`[Parse] Deinterleaved data (${dataCodewords.length} bytes):`, dataCodewords.slice(0, 20));

        // Deinterleave ECC codewords
        const eccCodewords = this.deinterleave(
            codewords.slice(blockSpec.totalDataBytes, blockSpec.totalCodewords),
            blockSpec.totalBlocks,
            blockSpec.eccPerBlock
        );

        console.log(`[Parse] Deinterleaved ECC:`, eccCodewords.slice(0, 20));

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
        const candidates = this.moduleTransforms(normalizedModules).flatMap(({ name, modules: candidateModules }) => {
            try {
                const formatInfo = this.readFormatInfo(candidateModules);
                const version = this.detectVersion(candidateModules.length);
                const results = [];

                const formatIsReliable = (formatInfo.errors || 0) <= 3;
                const eccLevels = formatIsReliable ? [formatInfo.eccLevel] : ['L', 'M', 'Q', 'H'];
                const masks = formatIsReliable ? [formatInfo.mask] : [0, 1, 2, 3, 4, 5, 6, 7];

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
                        parsed.score = this.scoreParseCandidate(parsed, expectedBytes);
                        if (!formatIsReliable && (eccLevel !== formatInfo.eccLevel || mask !== formatInfo.mask)) {
                            parsed.score += expectedBytes.length > 0 ? 25000 : 1000;
                        }
                        results.push(parsed);
                    }
                }
                return results;
            } catch (e) {
                return [];
            }
        }).sort((a, b) => a.score - b.score);

        if (!candidates.length) {
            throw new Error('Could not parse QR module grid in any orientation');
        }
        return candidates[0];
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

        if (payload.mode !== 4 && payload.mode !== 7) score += 10000;
        if (!payload.validCount) score += 5000;

        if (expectedBytes.length > 0) {
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
        console.log(`[Module Detection] QR bounds: ${qrWidth}×${qrHeight} px, grid: ${bestSize}×${bestSize}, module: ${moduleSize.toFixed(2)}px`);

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
            [size-5,8,4],[size-6,8,5],[size-7,8,6],
            [8,size-8,7],[8,size-7,8],[8,size-6,9],[8,size-5,10],
            [8,size-4,11],[8,size-3,12],[8,size-2,13],[8,size-1,14]
        ];
        for (const [x, y, bit] of secondaryOrder) {
            if (modules[y][x]) sec |= 1 << bit;
        }

        // Decode whichever copy has fewer BCH errors
        const r1 = this.decodeFormatInt(primary);
        const r2 = this.decodeFormatInt(sec);
        return r1.errors <= r2.errors ? r1 : r2;
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
     * Extract padding secret from data codewords
     */
    extractPaddingSecret(dataCodewords, version = 5) {
        console.log(`[Padding] Extracting from ${dataCodewords.length} bytes, version ${version}`);
        console.log(`[Padding] First 15 bytes:`, dataCodewords.slice(0, 15));

        // Calculate where padding starts
        // For byte mode: mode(4 bits) + count(8 bits for v<=9) + data

        const capacityBits = dataCodewords.length * 8;
        const ccBits = version <= 9 ? 8 : 16; // Character count bits

        // Try to read the actual message length from the data
        // First byte has mode in top 4 bits, start of count in bottom 4 bits
        const firstByte = dataCodewords[0];
        const mode = (firstByte >> 4) & 0x0F;

        let decoyLen = 8; // Default for "SCAN ME!"

        // Try to read character count
        if (ccBits === 8) {
            // Count is in bits 4-11 (parts of byte 0 and byte 1)
            const count_msb = firstByte & 0x0F;
            const count_lsb = (dataCodewords[1] >> 4) & 0x0F;
            decoyLen = (count_msb << 4) | count_lsb;
        }

        console.log(`[Padding] Mode: ${mode}, Decoy length: ${decoyLen}`);

        // Calculate bit usage
        const modeBits = 4;
        const usedBits = modeBits + ccBits + (8 * decoyLen);
        const termBits = Math.min(4, capacityBits - usedBits);
        const afterTerm = usedBits + termBits;

        // Pad to byte boundary
        const padStartBit = afterTerm + ((-afterTerm) % 8);
        const padByteStart = Math.floor(padStartBit / 8);

        console.log(`[Padding] Padding starts at byte ${padByteStart}`);
        console.log(`[Padding] Bytes at padding start:`, dataCodewords.slice(padByteStart, padByteStart + 5));

        // Check if we have room for length prefix
        if (padByteStart + 1 > dataCodewords.length) {
            console.log(`[Padding] Not enough room for length prefix`);
            return '';
        }

        // Read length-prefixed secret (1 byte)
        const secretLen = dataCodewords[padByteStart];

        console.log(`[Padding] Secret length from prefix: ${secretLen}`);

        // Validate
        if (secretLen === 0 || secretLen > 255 || padByteStart + 1 + secretLen > dataCodewords.length) {
            console.log(`[Padding] Invalid secret length`);
            return '';
        }

        // Extract secret
        const secret = dataCodewords.slice(padByteStart + 1, padByteStart + 1 + secretLen);
        console.log(`[Padding] Secret bytes:`, secret);
        const secretStr = this.bytesToString(secret);
        console.log(`[Padding] Secret string: "${secretStr}"`);
        return secretStr;
    },

    /**
     * Extract ECC secret from ECC codewords
     */
    extractECCSecret(eccCodewords, kPerBlock, numBlocks, eccPerBlock) {
        // Suffix format over deinterleaved ECC bytes in block order:
        // final byte = length; previous length bytes = reversed secret.
        console.log(`[ECC] Total ECC codewords: ${eccCodewords.length}`);

        if (eccCodewords.length >= 1) {
            const length = eccCodewords[eccCodewords.length - 1];
            console.log(`[ECC] Secret length from suffix: ${length}`);
            if (length > 0 && 1 + length <= eccCodewords.length && length < 255) {
                const secret = eccCodewords
                    .slice(eccCodewords.length - 1 - length, eccCodewords.length - 1)
                    .reverse();
                const secretStr = this.bytesToString(secret);
                console.log(`[ECC] Secret string: "${secretStr}"`);
                return secretStr;
            }
        }

        console.log(`[ECC] No valid secret found`);
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
