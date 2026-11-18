import { describe, expect, it } from 'vitest';
import { ConfigError, loadApiConfig, loadDatabaseConfig } from './index';

const valid = {
  DATABASE_URL: 'postgres://narada:narada@localhost:5433/narada',
  REDIS_URL: 'redis://localhost:6380',
};

describe('loadApiConfig', () => {
  it('applies defaults and coerces the port', () => {
    const config = loadApiConfig({ ...valid, API_PORT: '4100' });
    expect(config.API_PORT).toBe(4100);
    expect(config.API_HOST).toBe('127.0.0.1');
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.NODE_ENV).toBe('development');
  });

  it('rejects a missing DATABASE_URL and names the variable', () => {
    expect(() => loadApiConfig({ REDIS_URL: valid.REDIS_URL })).toThrow(ConfigError);
    try {
      loadApiConfig({ REDIS_URL: valid.REDIS_URL });
    } catch (error) {
      expect((error as ConfigError).invalidKeys).toContain('DATABASE_URL');
    }
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadApiConfig({ ...valid, DATABASE_URL: 'mysql://x/y' })).toThrow(/DATABASE_URL/);
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadApiConfig({ ...valid, API_PORT: '70000' })).toThrow(/API_PORT/);
  });

  it('never echoes secret values in its error message', () => {
    const secret = 'super-secret-password-123';
    try {
      loadApiConfig({ ...valid, DATABASE_URL: `mysql://user:${secret}@host/db` });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('loadDatabaseConfig', () => {
  it('only requires the database URL', () => {
    expect(loadDatabaseConfig({ DATABASE_URL: valid.DATABASE_URL }).DATABASE_URL).toBe(valid.DATABASE_URL);
  });
});
