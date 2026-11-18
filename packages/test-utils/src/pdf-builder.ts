import { createHash } from 'node:crypto';

/**
 * Minimal PDF writer for tests. Produces small, valid, single-font (Helvetica / WinAnsi) documents so the
 * extractor can be exercised without binary fixtures or PDF libraries. Text must be Latin-1.
 * It can also emit image-only pages (what a scanned document looks like) and RC4-40 encrypted files that
 * require a password (standard security handler, revision 2).
 */

export interface PdfLine {
  text: string;
  /** Font size in points (default 11). */
  size?: number;
  /** Extra vertical space above this line, in points. */
  gapBefore?: number;
}

export interface PdfPageSpec {
  lines?: PdfLine[];
  /** Draw a full-page raster image and no text: an image-only ("scanned") page. */
  image?: boolean;
}

export interface BuildPdfOptions {
  title?: string;
  /** Encrypt with a non-empty user password so readers must supply it. */
  userPassword?: string;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 255) throw new Error(`pdf-builder supports Latin-1 only; got U+${code.toString(16)}`);
    out[i] = code;
  }
  return out;
}

function escapeString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256).map((_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 255;
    b = (b + s[a]!) & 255;
    [s[a], s[b]] = [s[b]!, s[a]!];
    out[n] = data[n]! ^ s[(s[a]! + s[b]!) & 255]!;
  }
  return out;
}

const md5 = (...parts: Uint8Array[]): Uint8Array => {
  const hash = createHash('md5');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};

const PASSWORD_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const padPassword = (password: string): Uint8Array => {
  const bytes = latin1(password).slice(0, 32);
  const out = new Uint8Array(32);
  out.set(bytes);
  out.set(PASSWORD_PAD.subarray(0, 32 - bytes.length), bytes.length);
  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function contentStream(page: PdfPageSpec): string {
  if (page.image) return 'q 612 0 0 792 0 0 cm /Im1 Do Q';
  const ops: string[] = [];
  let y = 740;
  for (const line of page.lines ?? []) {
    const size = line.size ?? 11;
    y -= (line.gapBefore ?? 0) + size * 1.4;
    if (line.text.length === 0) continue;
    // Text past the right page edge is not visible content (readers such as Poppler also drop it), so wrap long
    // lines onto following lines of the same paragraph, as a word processor would.
    const maxChars = Math.floor(440 / (size * 0.55));
    const wrapped: string[] = [];
    let current = '';
    for (const word of line.text.split(' ')) {
      if (current && current.length + 1 + word.length > maxChars) {
        wrapped.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    wrapped.push(current);
    wrapped.forEach((segment, i) => {
      if (i > 0) y -= size * 1.4;
      ops.push(`BT /F1 ${size} Tf 72 ${y.toFixed(2)} Td (${escapeString(segment)}) Tj ET`);
    });
  }
  return ops.join('\n');
}

export function buildPdf(pages: PdfPageSpec[], options: BuildPdfOptions = {}): Uint8Array {
  if (pages.length === 0) throw new Error('A PDF needs at least one page');
  const hasImage = pages.some((p) => p.image);

  // Encryption material (RC4-40, R=2). The user password is non-empty so an empty-password open fails.
  let fileKey: Uint8Array | undefined;
  let encryptDict = '';
  const id = md5(latin1('narada-test-id'));
  if (options.userPassword !== undefined) {
    const ownerKey = md5(padPassword('owner-secret')).subarray(0, 5);
    const o = rc4(ownerKey, padPassword(options.userPassword));
    const permissions = -4;
    const p32 = new Uint8Array(4);
    new DataView(p32.buffer).setInt32(0, permissions, true);
    fileKey = md5(padPassword(options.userPassword), o, p32, id).subarray(0, 5);
    const u = rc4(fileKey, PASSWORD_PAD);
    encryptDict = `<< /Filter /Standard /V 1 /R 2 /O <${hex(o)}> /U <${hex(u)}> /P ${permissions} >>`;
  }

  const objects: Array<{ num: number; body: () => Uint8Array }> = [];
  const objectKey = (num: number): Uint8Array =>
    md5(fileKey!, Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(
      0,
      Math.min(fileKey!.length + 5, 16),
    );
  const encryptBytes = (num: number, data: Uint8Array): Uint8Array =>
    fileKey ? rc4(objectKey(num), data) : data;

  const add = (num: number, body: () => Uint8Array) => objects.push({ num, body });
  const text = (value: string) => latin1(value);

  const pageObjNums = pages.map((_, i) => 5 + i * 2);
  const infoNum = 5 + pages.length * 2 + 1;
  const imageNum = 5 + pages.length * 2;
  const encryptNum = infoNum + 1;

  add(1, () => text('<< /Type /Catalog /Pages 2 0 R >>'));
  add(2, () =>
    text(`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`),
  );
  add(3, () => text('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
  add(4, () => text('<< >>'));

  pages.forEach((page, i) => {
    const pageNum = pageObjNums[i]!;
    const contentNum = pageNum + 1;
    const resources = page.image
      ? `/Resources << /XObject << /Im1 ${imageNum} 0 R >> >>`
      : '/Resources << /Font << /F1 3 0 R >> >>';
    add(pageNum, () =>
      text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ${resources} /Contents ${contentNum} 0 R >>`),
    );
    add(contentNum, () => {
      const data = encryptBytes(contentNum, text(contentStream(page)));
      return concat(text(`<< /Length ${data.length} >>\nstream\n`), data, text('\nendstream'));
    });
  });

  if (hasImage) {
    add(imageNum, () => {
      const data = encryptBytes(imageNum, Uint8Array.from([0x80]));
      return concat(
        text(
          `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${data.length} >>\nstream\n`,
        ),
        data,
        text('\nendstream'),
      );
    });
  }

  add(infoNum, () => {
    const title = options.title ?? '';
    if (!title) return text('<< /Producer (narada-test) >>');
    if (!fileKey) return text(`<< /Title (${escapeString(title)}) /Producer (narada-test) >>`);
    const encrypted = encryptBytes(infoNum, latin1(title));
    return text(`<< /Title <${hex(encrypted)}> /Producer (narada-test) >>`);
  });
  if (fileKey) add(encryptNum, () => text(encryptDict));

  const header = concat(text('%PDF-1.4\n'), Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const chunks: Uint8Array[] = [header];
  const offsets = new Map<number, number>();
  let position = header.length;
  for (const { num, body } of [...objects].sort((a, b) => a.num - b.num)) {
    offsets.set(num, position);
    const piece = concat(text(`${num} 0 obj\n`), body(), text('\nendobj\n'));
    chunks.push(piece);
    position += piece.length;
  }
  const maxNum = Math.max(...offsets.keys());
  const xrefStart = position;
  let xref = `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) {
    const offset = offsets.get(n);
    xref += offset === undefined ? '0000000000 65535 f \n' : `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const idHex = hex(id);
  const trailer =
    `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R /Info ${infoNum} 0 R` +
    `${fileKey ? ` /Encrypt ${encryptNum} 0 R` : ''} /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(text(xref + trailer));
  return concat(...chunks);
}

/** A PDF whose body is cut off mid-file: a realistic malformed/truncated upload. */
export function truncatePdf(pdf: Uint8Array, keepFraction = 0.4): Uint8Array {
  return pdf.slice(0, Math.max(16, Math.floor(pdf.length * keepFraction)));
}
