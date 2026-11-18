import { LICENSE_KINDS, SOURCE_TYPES } from '@narada/database';
import { SHA256_HEX } from '@narada/shared';
import { z } from 'zod';

const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const PARTIAL_DATE = /^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$/;

/** Optional text: omitted or null becomes null; an empty string is rejected rather than silently dropped. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'must not be empty; omit the field or send null if unknown')
    .max(max)
    .nullish()
    .transform((value) => value ?? null);

const optionalHttpUrl = z
  .url({ protocol: /^https?$/, hostname: z.regexes.domain })
  .max(2048)
  .nullish()
  .transform((value) => value ?? null);

const optionalLanguage = z
  .string()
  .trim()
  .regex(BCP47, 'must be a BCP-47 language tag such as "en", "sa" or "hi-Deva"')
  .nullish()
  .transform((value) => value ?? null);

const optionalPublicationDate = z
  .string()
  .trim()
  .regex(PARTIAL_DATE, 'must be YYYY, YYYY-MM or YYYY-MM-DD')
  .refine(isValidPartialDate, 'is not a real calendar date')
  .nullish()
  .transform((value) => value ?? null);

function isValidPartialDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number | undefined, number | undefined];
  if (month === undefined) return true;
  if (month < 1 || month > 12) return false;
  if (day === undefined) return true;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

const licenseSchema = z.strictObject({
  kind: z.enum(LICENSE_KINDS),
  url: optionalHttpUrl,
  notes: optionalText(4000),
});

const permissionsSchema = z.strictObject({
  allowIndexing: z.boolean().default(false),
  allowQuotation: z.boolean().default(false),
  allowRedistribution: z.boolean().default(false),
});

/**
 * Mirrors the CHECK constraints in the database so clients get a precise 400 instead of a constraint
 * error. The database remains the final authority; these rules exist for error quality, not safety.
 */
export const createSourceSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(1000),
    author: optionalText(500),
    publisher: optionalText(500),
    sourceType: z.enum(SOURCE_TYPES),
    originalUrl: optionalHttpUrl,
    originalLanguage: optionalLanguage,
    publicationDate: optionalPublicationDate,
    edition: optionalText(500),
    license: licenseSchema,
    permissions: permissionsSchema.default({
      allowIndexing: false,
      allowQuotation: false,
      allowRedistribution: false,
    }),
    contentChecksum: z
      .string()
      .trim()
      .toLowerCase()
      .regex(SHA256_HEX, 'must be a 64-character hex SHA-256')
      .nullish()
      .transform((value) => value ?? null),
  })
  .superRefine((value, ctx) => {
    const { license, permissions } = value;
    if (permissions.allowIndexing && (license.kind === 'unknown' || license.kind === 'proprietary')) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'allowIndexing'],
        message: `cannot be true when the licence kind is "${license.kind}": indexing needs a documented legal basis`,
      });
    }
    if ((license.kind === 'licensed' || license.kind === 'permission_granted') && license.notes === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['license', 'notes'],
        message: `is required when the licence kind is "${license.kind}": reference the licence or permission evidence`,
      });
    }
    if (!permissions.allowIndexing && permissions.allowQuotation) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'allowQuotation'],
        message: 'requires allowIndexing to be true',
      });
    }
    if (!permissions.allowIndexing && permissions.allowRedistribution) {
      ctx.addIssue({
        code: 'custom',
        path: ['permissions', 'allowRedistribution'],
        message: 'requires allowIndexing to be true',
      });
    }
  });

export type CreateSourceInput = z.output<typeof createSourceSchema>;
