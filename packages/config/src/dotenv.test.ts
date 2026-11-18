import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv } from './index';

const created: string[] = [];
const touched: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of touched.splice(0)) delete process.env[key];
});

function workspace(env?: string): { root: string; nested: string } {
  const root = mkdtempSync(join(tmpdir(), 'narada-dotenv-'));
  created.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
  if (env !== undefined) writeFileSync(join(root, '.env'), env);
  const nested = join(root, 'packages', 'x');
  mkdirSync(nested, { recursive: true });
  return { root, nested };
}

describe('loadDotEnv', () => {
  it('loads the workspace-root .env when called from a nested package directory', () => {
    touched.push('NARADA_TEST_A');
    const { root, nested } = workspace('NARADA_TEST_A=from-file\n');
    expect(loadDotEnv(nested)).toBe(join(root, '.env'));
    expect(process.env.NARADA_TEST_A).toBe('from-file');
  });

  it('never overwrites a variable that is already set', () => {
    touched.push('NARADA_TEST_B');
    process.env.NARADA_TEST_B = 'from-shell';
    const { nested } = workspace('NARADA_TEST_B=from-file\n');
    loadDotEnv(nested);
    expect(process.env.NARADA_TEST_B).toBe('from-shell');
  });

  it('returns null when the workspace has no .env', () => {
    expect(loadDotEnv(workspace().nested)).toBeNull();
  });

  it('returns null outside any workspace instead of reading an unrelated .env', () => {
    const lonely = mkdtempSync(join(tmpdir(), 'narada-nows-'));
    created.push(lonely);
    writeFileSync(join(lonely, '.env'), 'NARADA_TEST_C=should-not-load\n');
    touched.push('NARADA_TEST_C');
    expect(loadDotEnv(lonely)).toBeNull();
    expect(process.env.NARADA_TEST_C).toBeUndefined();
  });
});
