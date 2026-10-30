// shared/stored-zip.js — a minimal ZIP writer and reader. v0.2
//
// WRITER (W8): blank-artifact skeleton archives — a straight port of MvuStatMenuBuilder's proven
// landing-app/src/utils/stored-zip.js (its bootstrap archives, tested against bsdtar and
// Expand-Archive); keep the two aligned when either grows.
// READER (G5): the source-folder import accepts a zipped workspace, and a zip a developer makes
// with any normal tool is DEFLATE-compressed, so the reader handles methods 0 and 8 — inflation is
// the platform's own DecompressionStream('deflate-raw'), no library.
//
// STORED entries only (method 0, no compression): every member is a small text file, so
// compressing buys kilobytes and costs a deflate implementation or a host dependency (ST bundles
// JSZip but its lib.js does not export it — W8's row weighed exactly this trade). Any unzip tool
// reads method 0.
//
// DETERMINISTIC on purpose: the timestamp is a fixed constant, so the same members yield the
// same bytes — the test suite asserts output byte-for-byte, and an unchanged skeleton produces an
// identical archive instead of a spurious diff.
//
// Pure: [{ path, text }] in, Uint8Array out. No host imports, no logging.

// CRC-32 (ISO 3309), table-driven — ZIP's one non-trivial requirement.
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

// A fixed DOS date/time (2026-01-01 00:00:00) — see the determinism note above.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const enc = new TextEncoder();

function push16(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff); }
function push32(arr, v) { arr.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff); }

// Members: [{ path, text }] — forward-slash paths, UTF-8 names (general-purpose flag bit 11).
// Directory entries are not emitted; every mainstream extractor creates parents from file paths.
export function buildStoredZip(members) {
    const chunks = [];
    const central = [];
    let offset = 0;

    for (const m of members) {
        const name = enc.encode(String(m.path));
        const data = enc.encode(String(m.text));
        const crc = crc32(data);

        const local = [];
        push32(local, 0x04034b50);          // local file header
        push16(local, 20);                  // version needed
        push16(local, 0x0800);              // flags: UTF-8 name
        push16(local, 0);                   // method: stored
        push16(local, DOS_TIME);
        push16(local, DOS_DATE);
        push32(local, crc);
        push32(local, data.length);         // compressed == uncompressed (stored)
        push32(local, data.length);
        push16(local, name.length);
        push16(local, 0);                   // no extra field
        const localHeader = new Uint8Array(local);

        const cd = [];
        push32(cd, 0x02014b50);             // central directory header
        push16(cd, 20);                     // version made by
        push16(cd, 20);                     // version needed
        push16(cd, 0x0800);
        push16(cd, 0);
        push16(cd, DOS_TIME);
        push16(cd, DOS_DATE);
        push32(cd, crc);
        push32(cd, data.length);
        push32(cd, data.length);
        push16(cd, name.length);
        push16(cd, 0);                      // extra
        push16(cd, 0);                      // comment
        push16(cd, 0);                      // disk number
        push16(cd, 0);                      // internal attrs
        push32(cd, 0);                      // external attrs
        push32(cd, offset);                 // local header offset
        central.push({ header: new Uint8Array(cd), name });

        chunks.push(localHeader, name, data);
        offset += localHeader.length + name.length + data.length;
    }

    const cdStart = offset;
    for (const c of central) {
        chunks.push(c.header, c.name);
        offset += c.header.length + c.name.length;
    }

    const end = [];
    push32(end, 0x06054b50);                // end of central directory
    push16(end, 0);                         // disk
    push16(end, 0);                         // cd disk
    push16(end, members.length);
    push16(end, members.length);
    push32(end, offset - cdStart);          // cd size
    push32(end, cdStart);                   // cd offset
    push16(end, 0);                         // comment length
    chunks.push(new Uint8Array(end));

    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
}

// ── the reader (G5 import) ───────────────────────────────────────────────────

const read16 = (b, at) => b[at] | (b[at + 1] << 8);
const read32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

// Inflate one raw-deflate member. DecompressionStream is a web standard the browser and node (18+)
// both ship, which is what keeps this module dependency-free in both realms the suite runs in.
async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Zip bytes -> [{ path, bytes }]. Directory rows are skipped (they carry no content); everything
// else is returned, because deciding which FILES matter is the assembler's job, not the unzipper's.
// THROWS naming the defect on anything this reader cannot honestly deliver: no central directory,
// an encrypted entry, a compression method other than stored/deflate, or a member whose CRC does
// not match after extraction — a silently truncated entry would surface later as a phantom
// assembly error blaming the wrong layer.
export async function readZip(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    // End-of-central-directory: scan back over the (usually empty) archive comment.
    let eocd = -1;
    for (let at = b.length - 22; at >= 0 && at >= b.length - 22 - 0xffff; at--) {
        if (read32(b, at) === 0x06054b50) { eocd = at; break; }
    }
    if (eocd < 0) throw new Error('not a zip file — no end-of-central-directory record');
    const count = read16(b, eocd + 10);
    let at = read32(b, eocd + 16);

    const decodeName = new TextDecoder();
    const out = [];
    for (let i = 0; i < count; i++) {
        if (read32(b, at) !== 0x02014b50) throw new Error('zip central directory is corrupt at entry ' + i);
        const flags = read16(b, at + 8);
        const method = read16(b, at + 10);
        const crc = read32(b, at + 16);
        const compressedSize = read32(b, at + 20);
        const nameLength = read16(b, at + 28);
        const extraLength = read16(b, at + 30);
        const commentLength = read16(b, at + 32);
        const localOffset = read32(b, at + 42);
        const path = decodeName.decode(b.subarray(at + 46, at + 46 + nameLength));
        at += 46 + nameLength + extraLength + commentLength;

        if (path.endsWith('/')) continue;   // directory row — parents come from file paths
        if (flags & 0x0001) throw new Error('"' + path + '" is encrypted — this importer reads plain archives only');
        if (method !== 0 && method !== 8) throw new Error('"' + path + '" uses compression method ' + method + ' — only stored (0) and deflate (8) are readable');

        // Sizes come from the CENTRAL directory: with flag bit 3 the local header holds zeros and
        // the truth trails the data. The local header is read only to find where the data starts.
        if (read32(b, localOffset) !== 0x04034b50) throw new Error('"' + path + '": local header not found where the central directory points');
        const dataStart = localOffset + 30 + read16(b, localOffset + 26) + read16(b, localOffset + 28);
        const raw = b.subarray(dataStart, dataStart + compressedSize);
        const data = method === 0 ? new Uint8Array(raw) : await inflateRaw(raw);
        if (crc32(data) !== crc) throw new Error('"' + path + '" failed its CRC check — the archive is damaged');
        out.push({ path, bytes: data });
    }
    return out;
}
