import type { AttachmentKind } from './generated/mrOneHookModels';

/**
 * What an uploaded file really is, read from its bytes. The name and the declared `Content-Type` are
 * only hints (they choose between types that share a container, e.g. audio-only vs video WebM); a file
 * whose bytes match nothing supported is refused, so an executable renamed `.pdf` never reaches a parser.
 *
 * Office files are ZIP archives: their central directory is read (no decompression) to tell DOCX / XLSX /
 * PPTX apart and to refuse archive bombs (too many entries or too many uncompressed bytes). Any other ZIP
 * is refused. Plain text must be valid UTF-8 without NUL bytes.
 */
export interface DetectedType {
  kind: AttachmentKind;
  mediaType: string;
  /** How the content is read. */
  reader: 'vision' | 'document' | 'text' | 'transcription' | 'video';
  /** File extension the AI services expect for this type. */
  extension: string;
}

const MAX_ZIP_ENTRIES = 5_000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

const TEXT_EXTENSIONS: Readonly<Record<string, string>> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  vtt: 'text/vtt', srt: 'application/x-subrip', json: 'application/json', log: 'text/plain',
};

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return Buffer.from(bytes.subarray(from, Math.min(to, bytes.length))).toString('latin1');
}

function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName.trim());
  return match ? match[1]!.toLowerCase() : '';
}

/** ISO BMFF (`ftyp` box): MP4, M4A, MOV, HEIC. */
function isoBrand(bytes: Uint8Array): { major: string; brands: string[] } | undefined {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== 'ftyp') return undefined;
  const size = Buffer.from(bytes.subarray(0, 4)).readUInt32BE(0);
  const end = Math.min(Math.max(size, 16), bytes.length, 256);
  const brands: string[] = [];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(bytes, i, i + 4));
  return { major: ascii(bytes, 8, 12), brands };
}

/** The entry names of a ZIP's central directory, or undefined when it is not a sane ZIP. */
export function zipEntryNames(bytes: Uint8Array): string[] | undefined {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: within the last 64 KiB + 22 bytes (comment length is at most 65535).
  const searchFrom = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= searchFrom; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return undefined;
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 markers or a directory outside the file: refuse rather than guess.
  if (entries === 0xffff || cdOffset === 0xffffffff || entries > MAX_ZIP_ENTRIES || cdOffset + cdSize > buf.length) return undefined;
  const names: string[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return undefined;
    const uncompressed = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    if (uncompressed === 0xffffffff) return undefined;
    total += uncompressed;
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) return undefined;
    names.push(buf.subarray(p + 46, p + 46 + nameLength).toString('utf8'));
    p += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function officeType(bytes: Uint8Array): DetectedType | undefined {
  const names = zipEntryNames(bytes);
  if (!names || !names.includes('[Content_Types].xml')) return undefined;
  if (names.some((n) => n.startsWith('word/'))) {
    return { kind: 'document', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', reader: 'document', extension: 'docx' };
  }
  if (names.some((n) => n.startsWith('xl/'))) {
    return { kind: 'document', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', reader: 'document', extension: 'xlsx' };
  }
  if (names.some((n) => n.startsWith('ppt/'))) {
    return { kind: 'document', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', reader: 'document', extension: 'pptx' };
  }
  return undefined;
}

function isUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function detectAttachmentType(bytes: Uint8Array, declaredType: string, fileName: string): DetectedType | undefined {
  const declared = declaredType.split(';')[0]!.trim().toLowerCase();
  const ext = extensionOf(fileName);
  const prefersAudio = declared.startsWith('audio/');

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mediaType: 'image/png', reader: 'vision', extension: 'png' };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: 'image', mediaType: 'image/jpeg', reader: 'vision', extension: 'jpg' };
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return { kind: 'image', mediaType: 'image/gif', reader: 'vision', extension: 'gif' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { kind: 'image', mediaType: 'image/webp', reader: 'vision', extension: 'webp' };
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return { kind: 'audio', mediaType: 'audio/wav', reader: 'transcription', extension: 'wav' };
  if (ascii(bytes, 0, 5) === '%PDF-') return { kind: 'document', mediaType: 'application/pdf', reader: 'document', extension: 'pdf' };
  if (ascii(bytes, 0, 4) === 'OggS') return { kind: 'audio', mediaType: 'audio/ogg', reader: 'transcription', extension: 'ogg' };
  if (ascii(bytes, 0, 4) === 'fLaC') return { kind: 'audio', mediaType: 'audio/flac', reader: 'transcription', extension: 'flac' };
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes.length > 2 && bytes[0] === 0xff && (bytes[1]! & 0xe6) === 0xe2)) {
    // MPEG audio Layer III frame sync (not the AAC ADTS 0xFFF1 / 0xFFF9 headers, which the AI service refuses).
    return { kind: 'audio', mediaType: 'audio/mpeg', reader: 'transcription', extension: 'mp3' };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return prefersAudio
      ? { kind: 'audio', mediaType: 'audio/webm', reader: 'transcription', extension: 'webm' }
      : { kind: 'video', mediaType: 'video/webm', reader: 'video', extension: 'webm' };
  }
  const iso = isoBrand(bytes);
  if (iso) {
    const brands = [iso.major, ...iso.brands];
    if (brands.some((b) => ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(b))) {
      // HEIC: read through Document Intelligence (text only); apps send JPEG where they can.
      return { kind: 'image', mediaType: 'image/heic', reader: 'document', extension: 'heic' };
    }
    if (brands.some((b) => b === 'M4A ' || b === 'M4B ') || prefersAudio) {
      return { kind: 'audio', mediaType: 'audio/mp4', reader: 'transcription', extension: 'm4a' };
    }
    if (iso.major === 'qt  ') return { kind: 'video', mediaType: 'video/quicktime', reader: 'video', extension: 'mov' };
    return { kind: 'video', mediaType: 'video/mp4', reader: 'video', extension: 'mp4' };
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return officeType(bytes);

  const textType = TEXT_EXTENSIONS[ext];
  const declaredText = declared.startsWith('text/') || declared === 'application/json' || declared === 'application/x-subrip';
  if ((textType || declaredText) && isUtf8Text(bytes)) {
    const extension = textType ? ext : 'txt';
    return { kind: 'text', mediaType: textType ?? (declared.startsWith('text/') ? declared : 'text/plain'), reader: 'text', extension };
  }
  return undefined;
}
