import { pino, type Logger } from 'pino';

export type { Logger };

export interface LoggerOptions {
  level?: string;
  /** Logical process name, e.g. "api" or "ingestion-worker". */
  name: string;
}

/**
 * Structured JSON logger. Credentials are redacted defensively so that a stray
 * object spread into a log line cannot leak a secret.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino({
    name: options.name,
    level: options.level ?? 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.apiKey',
        '*.api_key',
        '*.password',
        '*.token',
        'apiKey',
        'password',
      ],
      censor: '[REDACTED]',
    },
  });
}
