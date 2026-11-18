import { describe, expect, it } from 'vitest';
import { buildPdf } from '@narada/test-utils';
import { validateUpload, type UploadFile } from './upload';

const enc = (s: string) => new TextEncoder().encode(s);
const file = (over: Partial<UploadFile> & { bytes: Uint8Array }): UploadFile => ({ filename: 'a.txt', declaredType: null, ...over });
const opts = { maxBytes: 1024 };

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('validateUpload', () => {
  it('accepts valid PDF, TXT and Markdown and reports content hash and canonical MIME type', () => {
    const pdf = validateUpload(file({ bytes: buildPdf([{ lines: [{ text: 'x' }] }]), filename: 'doc.PDF', declaredType: 'application/pdf' }), { maxBytes: 1e6 });
    expect(pdf).toMatchObject({ format: 'pdf', mimeType: 'application/pdf' });
    expect(pdf.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(validateUpload(file({ bytes: enc('hi'), filename: 'a.md', declaredType: 'text/markdown; charset=utf-8' }), opts)).toMatchObject({ format: 'markdown', mimeType: 'text/markdown' });
    expect(validateUpload(file({ bytes: enc('नमस्ते'), filename: 'a.txt', declaredType: 'application/octet-stream' }), opts).format).toBe('txt');
  });

  it('rejects empty files and files over the size limit', () => {
    expect(code(() => validateUpload(file({ bytes: new Uint8Array(0) }), opts))).toBe('INVALID_FILE_TYPE');
    expect(code(() => validateUpload(file({ bytes: new Uint8Array(2000).fill(65) }), opts))).toBe('FILE_TOO_LARGE');
  });

  it('rejects unsupported or missing extensions', () => {
    for (const filename of ['a.docx', 'a.exe', 'noextension', '.hidden', null]) {
      expect(code(() => validateUpload(file({ bytes: enc('x'), filename }), opts)), String(filename)).toBe('INVALID_FILE_TYPE');
    }
  });

  it('rejects a PDF extension on non-PDF content', () => {
    expect(code(() => validateUpload(file({ bytes: enc('just text'), filename: 'fake.pdf' }), opts))).toBe('INVALID_FILE_TYPE');
  });

  it('rejects executables and archives disguised as text, by signature and by NUL bytes', () => {
    const disguised: Array<[string, number[]]> = [
      ['exe', [0x4d, 0x5a, 0x90, 0x00, 0x03]],
      ['elf', [0x7f, 0x45, 0x4c, 0x46, 0x02]],
      ['zip', [0x50, 0x4b, 0x03, 0x04, 0x14]],
      ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d]],
    ];
    for (const [name, bytes] of disguised) {
      expect(code(() => validateUpload(file({ bytes: Uint8Array.from(bytes), filename: `${name}.txt` }), opts)), name).toBe('INVALID_FILE_TYPE');
    }
    expect(code(() => validateUpload(file({ bytes: Uint8Array.from([0x61, 0x00, 0x62, 0x00, 0x00]), filename: 'x.md' }), opts))).toBe('INVALID_FILE_TYPE');
  });

  it('rejects a real PDF renamed to .txt', () => {
    expect(code(() => validateUpload(file({ bytes: buildPdf([{ lines: [{ text: 'x' }] }]), filename: 'a.txt' }), { maxBytes: 1e6 }))).toBe('INVALID_FILE_TYPE');
  });

  it('rejects a declared content type that contradicts the extension', () => {
    expect(code(() => validateUpload(file({ bytes: enc('hi'), filename: 'a.txt', declaredType: 'application/x-msdownload' }), opts))).toBe('INVALID_FILE_TYPE');
    expect(code(() => validateUpload(file({ bytes: enc('hi'), filename: 'a.md', declaredType: 'application/pdf' }), opts))).toBe('INVALID_FILE_TYPE');
  });

  it('never uses the filename as a path: traversal names only contribute their extension', () => {
    const result = validateUpload(file({ bytes: enc('hi'), filename: '../../etc/passwd.txt' }), opts);
    expect(result.format).toBe('txt');
  });
});
