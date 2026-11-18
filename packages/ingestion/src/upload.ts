import { appErrors, sha256Hex } from '@narada/shared';
import { FORMAT_MIME } from './extractors/registry';
import type { DocumentFormat } from './model';
import { decodeText } from './text-decoding';

export interface UploadFile {
  bytes: Uint8Array;
  filename: string | null;
  /** Content-Type the client declared. Never trusted: only checked for consistency. */
  declaredType: string | null;
}

export interface ValidatedUpload {
  format: DocumentFormat;
  mimeType: string;
  sha256: string;
  byteSize: number;
}

const EXTENSIONS: Record<string, DocumentFormat> = { pdf: 'pdf', txt: 'txt', md: 'markdown', markdown: 'markdown' };

const COMPATIBLE_DECLARED: Record<DocumentFormat, string[]> = {
  pdf: ['application/pdf', 'application/x-pdf', 'application/octet-stream'],
  txt: ['text/plain', 'application/octet-stream'],
  markdown: ['text/markdown', 'text/x-markdown', 'text/plain', 'application/octet-stream'],
};

/** Signatures of executables, archives and images that must never be accepted as a text document. */
const BINARY_SIGNATURES: Array<{ name: string; bytes: number[] }> = [
  { name: 'Windows executable', bytes: [0x4d, 0x5a] },
  { name: 'ELF executable', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Mach-O executable', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O executable', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'ZIP archive (also Office/JAR/APK)', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'gzip archive', bytes: [0x1f, 0x8b] },
  { name: 'PNG image', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'JPEG image', bytes: [0xff, 0xd8, 0xff] },
  { name: 'GIF image', bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: 'OLE compound file', bytes: [0xd0, 0xcf, 0x11, 0xe0] },
];

const startsWith = (bytes: Uint8Array, signature: number[]) => signature.every((b, i) => bytes[i] === b);

function extensionOf(filename: string | null): string | null {
  if (!filename) return null;
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : null;
}

/**
 * Validates an upload before anything is stored. The extension chooses the format; the bytes must then actually
 * look like that format, and the client-declared MIME type must be consistent. Throws INVALID_FILE_TYPE or
 * FILE_TOO_LARGE. The filename is only ever read for its extension and never used as a path.
 */
export function validateUpload(file: UploadFile, options: { maxBytes: number }): ValidatedUpload {
  const { bytes } = file;
  if (bytes.length === 0) throw appErrors.invalidFileType('The uploaded file is empty.');
  if (bytes.length > options.maxBytes) throw appErrors.fileTooLarge(options.maxBytes);

  const extension = extensionOf(file.filename);
  const format = extension ? EXTENSIONS[extension] : undefined;
  if (!format) {
    throw appErrors.invalidFileType('Unsupported file type. Allowed extensions: .pdf, .txt, .md, .markdown.', {
      extension,
      allowed: Object.keys(EXTENSIONS),
    });
  }

  const declared = file.declaredType?.split(';')[0]?.trim().toLowerCase() || null;
  if (declared && !COMPATIBLE_DECLARED[format].includes(declared)) {
    throw appErrors.invalidFileType(`Declared content type "${declared}" is not valid for a .${extension} file.`, {
      declaredType: declared,
      expected: COMPATIBLE_DECLARED[format],
    });
  }

  if (format === 'pdf') {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    if (!head.includes('%PDF-')) {
      throw appErrors.invalidFileType('The file does not contain a PDF header (%PDF-); it is not a PDF.');
    }
  } else {
    for (const signature of BINARY_SIGNATURES) {
      if (startsWith(bytes, signature.bytes)) {
        throw appErrors.invalidFileType(`The file is a ${signature.name}, not a text document.`, { detected: signature.name });
      }
    }
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
      throw appErrors.invalidFileType('The file is a PDF but has a text extension; rename it to .pdf.');
    }
    const decoded = decodeText(bytes);
    if (!decoded.ok) throw appErrors.invalidFileType(decoded.message, decoded.details);
  }

  return { format, mimeType: FORMAT_MIME[format], sha256: sha256Hex(bytes), byteSize: bytes.length };
}
