// Minimal PNG writer (RGB, 8 bit) with tEXt chunks: placeholder images and character cards
// (SillyTavern keeps card JSON base64-encoded in the `chara` / `ccv3` tEXt chunks).
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

/**
 * Encodes a vertical two-colour gradient.
 * @param {{ width: number, height: number, top?: number[], bottom?: number[], text?: Record<string, string> }} options
 *   `text` values must be Latin-1 (use base64 for anything else).
 */
export function encodePng({ width, height, top = [40, 60, 90], bottom = [200, 170, 120], text = {} }) {
    const row = width * 3 + 1;
    const raw = Buffer.alloc(row * height);
    for (let y = 0; y < height; y++) {
        const t = height > 1 ? y / (height - 1) : 0;
        const color = top.map((c, i) => Math.round(c + (bottom[i] - c) * t));
        raw[y * row] = 0;
        for (let x = 0; x < width; x++) {
            const at = y * row + 1 + x * 3;
            raw[at] = color[0];
            raw[at + 1] = color[1];
            raw[at + 2] = color[2];
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type: RGB
    const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
    for (const [keyword, value] of Object.entries(text)) {
        parts.push(
            chunk(
                'tEXt',
                Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]),
            ),
        );
    }
    parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)));
    return Buffer.concat(parts);
}

/** A character card PNG: v2 JSON in `chara`, the v3 twin in `ccv3` (as SillyTavern writes them). */
export function encodeCardPng(card, options = {}) {
    const v2 = JSON.stringify(card);
    const v3 = JSON.stringify({ ...card, spec: 'chara_card_v3', spec_version: '3.0' });
    return encodePng({
        width: 256,
        height: 384,
        ...options,
        text: {
            chara: Buffer.from(v2, 'utf8').toString('base64'),
            ccv3: Buffer.from(v3, 'utf8').toString('base64'),
        },
    });
}
