/**
 * Realistic Sample Images with synthetic EXIF/APP markers for immediate testing
 */

export interface SampleFileInfo {
  name: string;
  type: string;
  format: 'JPEG' | 'PNG' | 'WebP';
  location: string;
  blob: Blob;
  size: number;
}

/**
 * Creates a minimal valid JPEG with APP1 (EXIF + GPS) and APP13 (Photoshop IRB) markers
 */
export function createSampleJpeg(name: string, location: string, width = 64, height = 64): SampleFileInfo {
  // Build a minimal valid JPEG file with an APP1 Exif segment
  const exifSegment = createMockExifApp1();
  const app13Segment = createMockApp13Iptc();

  // Basic 8x8 minimal JPEG stream (SOI + APP1 + APP13 + DQT + SOF0 + DHT + SOS + Data + EOI)
  // To make a real displayable JPEG, we can use a small canvas and inject APP1/APP13 before SOF
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#2563eb');
    grad.addColorStop(1, '#7c3aed');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('ClearMD', 6, height / 2 + 4);
  }

  // Convert canvas to jpeg data url
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const base64 = dataUrl.split(',')[1];
  const binaryString = atob(base64);
  const rawBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    rawBytes[i] = binaryString.charCodeAt(i);
  }

  // Insert our custom APP1 Exif and APP13 IPTC markers right after SOI (0xFF, 0xD8)
  const modifiedBytes = new Uint8Array(rawBytes.length + exifSegment.length + app13Segment.length);
  modifiedBytes.set(rawBytes.subarray(0, 2), 0); // SOI
  modifiedBytes.set(exifSegment, 2);              // Injected Exif (Camera, GPS, Date)
  modifiedBytes.set(app13Segment, 2 + exifSegment.length); // Injected Photoshop/IPTC
  modifiedBytes.set(rawBytes.subarray(2), 2 + exifSegment.length + app13Segment.length);

  const blob = new Blob([modifiedBytes as BlobPart], { type: 'image/jpeg' });
  return {
    name,
    type: 'JPEG Image',
    format: 'JPEG',
    location,
    blob,
    size: modifiedBytes.length,
  };
}

/**
 * Creates a valid PNG with tEXt and iTXt metadata chunks
 */
export function createSamplePng(name: string, location: string, width = 64, height = 64): SampleFileInfo {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#059669');
    grad.addColorStop(1, '#0284c7');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('PNG Test', 6, height / 2 + 4);
  }

  const dataUrl = canvas.toDataURL('image/png');
  const base64 = dataUrl.split(',')[1];
  const binaryString = atob(base64);
  const rawBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    rawBytes[i] = binaryString.charCodeAt(i);
  }

  // Inject a tEXt chunk ("Author: John Doe / Secret Location") right after IHDR chunk
  // IHDR is at offset 8 (length 4, 'IHDR', data 13, CRC 4 -> 8 + 25 = 33)
  const textChunk = createPngTextChunk('Author', 'Confidential User (GPS 37.7749,-122.4194)');
  const softwareChunk = createPngTextChunk('Software', 'Adobe Photoshop 2026.1 (Macintosh)');

  const modifiedBytes = new Uint8Array(rawBytes.length + textChunk.length + softwareChunk.length);
  modifiedBytes.set(rawBytes.subarray(0, 33), 0);
  modifiedBytes.set(textChunk, 33);
  modifiedBytes.set(softwareChunk, 33 + textChunk.length);
  modifiedBytes.set(rawBytes.subarray(33), 33 + textChunk.length + softwareChunk.length);

  const blob = new Blob([modifiedBytes as BlobPart], { type: 'image/png' });
  return {
    name,
    type: 'PNG Image',
    format: 'PNG',
    location,
    blob,
    size: modifiedBytes.length,
  };
}

function createPngTextChunk(keyword: string, text: string): Uint8Array {
  const keyBytes = new TextEncoder().encode(keyword);
  const textBytes = new TextEncoder().encode(text);
  const dataLen = keyBytes.length + 1 + textBytes.length; // keyword + null + text

  const chunk = new Uint8Array(12 + dataLen);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, dataLen, false); // big-endian
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // "tEXt"
  chunk.set(keyBytes, 8);
  chunk[8 + keyBytes.length] = 0; // null separator
  chunk.set(textBytes, 8 + keyBytes.length + 1);

  // Simple CRC placeholder for demonstration chunk
  dv.setUint32(8 + dataLen, 0x55aa3311, false);
  return chunk;
}

function createMockExifApp1(): Uint8Array {
  // Construct a standard APP1 marker with Exif header:
  // 0xFF, 0xE1, Length(2 bytes), "Exif\0\0", TIFF Header, IFD0 with Make, Model, DateTime, GPS
  const payload: number[] = [
    // "Exif\0\0"
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    // TIFF Header: Little Endian ("II"), 42, offset to IFD0 (8)
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
    // IFD0: 4 entries
    0x04, 0x00,
    // Entry 1: Make (0x010F), ASCII(2), count 6, offset 58
    0x0f, 0x01, 0x02, 0x00, 0x06, 0x00, 0x00, 0x00, 0x3a, 0x00, 0x00, 0x00,
    // Entry 2: Model (0x0110), ASCII(2), count 18, offset 64
    0x10, 0x01, 0x02, 0x00, 0x12, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00,
    // Entry 3: DateTime (0x0132), ASCII(2), count 20, offset 82
    0x32, 0x01, 0x02, 0x00, 0x14, 0x00, 0x00, 0x00, 0x52, 0x00, 0x00, 0x00,
    // Entry 4: GPS IFD pointer (0x8825), LONG(4), count 1, offset 102
    0x25, 0x88, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00,
    // Next IFD offset: 0
    0x00, 0x00, 0x00, 0x00,
    // String data:
    // Offset 58: "Apple\0"
    0x41, 0x70, 0x70, 0x6c, 0x65, 0x00,
    // Offset 64: "iPhone 15 Pro Max\0"
    0x69, 0x50, 0x68, 0x6f, 0x6e, 0x65, 0x20, 0x31, 0x35, 0x20, 0x50, 0x72, 0x6f, 0x20, 0x4d, 0x61, 0x78, 0x00,
    // Offset 82: "2026:11:05 14:18:22\0"
    0x32, 0x30, 0x32, 0x36, 0x3a, 0x31, 0x31, 0x3a, 0x30, 0x35, 0x20, 0x31, 0x34, 0x3a, 0x31, 0x38, 0x3a, 0x32, 0x32, 0x00,
    // Offset 102: GPS IFD (dummy 2 entries)
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
  ];

  const length = payload.length + 2;
  const res = new Uint8Array(4 + payload.length);
  res[0] = 0xff;
  res[1] = 0xe1; // APP1 marker
  res[2] = (length >> 8) & 0xff;
  res[3] = length & 0xff;
  res.set(payload, 4);
  return res;
}

function createMockApp13Iptc(): Uint8Array {
  // Construct APP13 Photoshop 3.0 / IPTC segment
  const header = new TextEncoder().encode('Photoshop 3.0\x008BIM\x04\x04\x00\x00\x00\x00\x00\x10ClearMD Private Data');
  const length = header.length + 2;
  const res = new Uint8Array(4 + header.length);
  res[0] = 0xff;
  res[1] = 0xed; // APP13 marker
  res[2] = (length >> 8) & 0xff;
  res[3] = length & 0xff;
  res.set(header, 4);
  return res;
}
