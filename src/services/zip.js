// Minimal ZIP reader (stored + deflate), enough for export archives from other apps.
// Bounded: refuses archives that would expand beyond `maxBytes` in total.
import zlib from 'node:zlib';
import { HttpError } from '../util.js';

export function isZip(buf) {
  return Buffer.isBuffer(buf) && buf.length > 22 && buf.readUInt32LE(0) === 0x04034b50;
}

/** Returns a Map of file name -> Buffer (directories and macOS metadata skipped). */
export function readZip(buf, { maxBytes = 512 * 1024 * 1024, maxFiles = 2000 } = {}) {
  // end of central directory: last 0x06054b50 within the final 64 KB
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new HttpError(400, 'Not a valid ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new HttpError(400, 'ZIP has too many files');
  const out = new Map();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new HttpError(400, 'Corrupt ZIP directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\._/.test(name)) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new HttpError(400, 'Corrupt ZIP entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    total += usize;
    if (total > maxBytes) throw new HttpError(413, 'ZIP contents too large');
    let file;
    if (method === 0) file = data;
    else if (method === 8) {
      // corrupt data (or more of it than declared) is a bad upload, not a server error
      try { file = zlib.inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) }); } catch { throw new HttpError(400, `Corrupt ZIP data in ${name}`); }
    } else throw new HttpError(400, `Unsupported ZIP compression (${method}) for ${name}`);
    out.set(name, file);
  }
  return out;
}
