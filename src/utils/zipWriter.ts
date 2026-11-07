/**
 * Minimal zero-dependency ZIP archive writer
 * Creates standard PKZip uncompressed (Store) or deflated archives in-memory.
 */

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export class SimpleZip {
  private entries: ZipEntry[] = [];

  addFile(name: string, data: Uint8Array | string) {
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else {
      bytes = data;
    }
    this.entries.push({ name, data: bytes });
  }

  generateBlob(): Blob {
    const parts: Uint8Array[] = [];
    const centralDirectoryHeaders: Uint8Array[] = [];
    let offset = 0;

    for (const entry of this.entries) {
      const nameBytes = new TextEncoder().encode(entry.name);
      const crc = crc32(entry.data);
      const size = entry.data.length;

      // Local file header (30 bytes + name)
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(localHeader.buffer);

      dv.setUint32(0, 0x04034b50, true); // Local file header signature
      dv.setUint16(4, 20, true);          // Version needed to extract (2.0)
      dv.setUint16(6, 0, true);           // General purpose bit flag
      dv.setUint16(8, 0, true);           // Compression method (0 = Store)
      dv.setUint16(10, 0, true);          // Last mod file time
      dv.setUint16(12, 0, true);          // Last mod file date
      dv.setUint32(14, crc, true);        // CRC-32
      dv.setUint32(18, size, true);       // Compressed size
      dv.setUint32(22, size, true);       // Uncompressed size
      dv.setUint16(26, nameBytes.length, true); // File name length
      dv.setUint16(28, 0, true);          // Extra field length
      localHeader.set(nameBytes, 30);

      parts.push(localHeader);
      parts.push(entry.data);

      // Central directory header (46 bytes + name)
      const cdHeader = new Uint8Array(46 + nameBytes.length);
      const cdDv = new DataView(cdHeader.buffer);
      cdDv.setUint32(0, 0x02014b50, true); // Central directory file header signature
      cdDv.setUint16(4, 20, true);          // Version made by
      cdDv.setUint16(6, 20, true);          // Version needed to extract
      cdDv.setUint16(8, 0, true);           // Flags
      cdDv.setUint16(10, 0, true);          // Compression
      cdDv.setUint16(12, 0, true);          // Time
      cdDv.setUint16(14, 0, true);          // Date
      cdDv.setUint32(16, crc, true);        // CRC-32
      cdDv.setUint32(20, size, true);       // Comp size
      cdDv.setUint32(24, size, true);       // Uncomp size
      cdDv.setUint16(28, nameBytes.length, true);
      cdDv.setUint16(30, 0, true);          // Extra field len
      cdDv.setUint16(32, 0, true);          // File comment len
      cdDv.setUint16(34, 0, true);          // Disk start
      cdDv.setUint16(36, 0, true);          // Internal file attributes
      cdDv.setUint32(38, 0, true);          // External file attributes
      cdDv.setUint32(42, offset, true);     // Relative offset of local header
      cdHeader.set(nameBytes, 46);

      centralDirectoryHeaders.push(cdHeader);
      offset += localHeader.length + size;
    }

    const cdStartOffset = offset;
    let cdSize = 0;
    for (const c of centralDirectoryHeaders) {
      parts.push(c);
      cdSize += c.length;
    }

    // End of central directory record (22 bytes)
    const eocd = new Uint8Array(22);
    const eocdDv = new DataView(eocd.buffer);
    eocdDv.setUint32(0, 0x06054b50, true); // EOCD signature
    eocdDv.setUint16(4, 0, true);           // Disk number
    eocdDv.setUint16(6, 0, true);           // Start disk
    eocdDv.setUint16(8, this.entries.length, true);  // Records on this disk
    eocdDv.setUint16(10, this.entries.length, true); // Total records
    eocdDv.setUint32(12, cdSize, true);     // Size of central directory
    eocdDv.setUint32(16, cdStartOffset, true); // Offset of CD
    eocdDv.setUint16(20, 0, true);          // Comment length
    parts.push(eocd);

    return new Blob(parts as BlobPart[], { type: 'application/zip' });
  }
}

// Fast CRC32 calculation table
const crcTable: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}
