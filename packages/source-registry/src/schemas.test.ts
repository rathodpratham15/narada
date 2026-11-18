import { describe, expect, it } from 'vitest';
import { createSourceSchema } from './schemas';

const base = {
  title: 'Valmiki Ramayana',
  sourceType: 'scripture',
  license: { kind: 'public_domain' },
};

function issuePaths(input: unknown): string[] {
  const result = createSourceSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
}

describe('createSourceSchema', () => {
  it('accepts minimal input and does not invent missing metadata', () => {
    const parsed = createSourceSchema.parse(base);
    expect(parsed.author).toBeNull();
    expect(parsed.publisher).toBeNull();
    expect(parsed.edition).toBeNull();
    expect(parsed.originalUrl).toBeNull();
    expect(parsed.originalLanguage).toBeNull();
    expect(parsed.publicationDate).toBeNull();
    expect(parsed.contentChecksum).toBeNull();
  });

  it('defaults every permission to false', () => {
    expect(createSourceSchema.parse(base).permissions).toEqual({
      allowIndexing: false,
      allowQuotation: false,
      allowRedistribution: false,
    });
  });

  it('rejects empty strings instead of silently turning them into null', () => {
    expect(issuePaths({ ...base, author: '   ' })).toContain('author');
  });

  it('rejects unknown fields so typos are not silently ignored', () => {
    expect(issuePaths({ ...base, autor: 'Valmiki' }).length).toBeGreaterThan(0);
  });

  it('rejects indexing for unknown and proprietary licences', () => {
    for (const kind of ['unknown', 'proprietary']) {
      expect(issuePaths({ ...base, license: { kind }, permissions: { allowIndexing: true } })).toContain(
        'permissions.allowIndexing',
      );
    }
  });

  it('requires licence evidence notes for licensed and permission_granted', () => {
    for (const kind of ['licensed', 'permission_granted']) {
      expect(issuePaths({ ...base, license: { kind }, permissions: { allowIndexing: true } })).toContain(
        'license.notes',
      );
      expect(
        createSourceSchema.safeParse({
          ...base,
          license: { kind, notes: 'Written permission from the publisher, 2026-03-02' },
          permissions: { allowIndexing: true },
        }).success,
      ).toBe(true);
    }
  });

  it('requires indexing for quotation and redistribution', () => {
    expect(issuePaths({ ...base, permissions: { allowQuotation: true } })).toContain('permissions.allowQuotation');
    expect(issuePaths({ ...base, permissions: { allowRedistribution: true } })).toContain(
      'permissions.allowRedistribution',
    );
  });

  it.each(['1891', '1891-07', '1891-07-04'])('accepts partial date %s', (publicationDate) => {
    expect(createSourceSchema.safeParse({ ...base, publicationDate }).success).toBe(true);
  });

  it.each(['91', '1891-13', '1891-02-30', 'July 1891'])('rejects invalid date %s', (publicationDate) => {
    expect(issuePaths({ ...base, publicationDate })).toContain('publicationDate');
  });

  it('validates language tags and URLs', () => {
    expect(createSourceSchema.safeParse({ ...base, originalLanguage: 'hi-Deva' }).success).toBe(true);
    expect(issuePaths({ ...base, originalLanguage: 'not a tag' })).toContain('originalLanguage');
    expect(issuePaths({ ...base, originalUrl: 'ftp://example.org/x' })).toContain('originalUrl');
    expect(issuePaths({ ...base, originalUrl: 'javascript:alert(1)' })).toContain('originalUrl');
    expect(createSourceSchema.safeParse({ ...base, originalUrl: 'https://example.org/x' }).success).toBe(true);
  });

  it('normalises and validates a declared checksum', () => {
    const upper = 'A'.repeat(64);
    expect(createSourceSchema.parse({ ...base, contentChecksum: upper }).contentChecksum).toBe('a'.repeat(64));
    expect(issuePaths({ ...base, contentChecksum: 'abc' })).toContain('contentChecksum');
  });
});
