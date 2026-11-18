import { ConfigError, loadDotEnv, loadWorkerConfig } from '@narada/config';
import { createDatabase } from '@narada/database';
import { DEFAULT_EXTRACTION_LIMITS } from '@narada/ingestion';
import { createLogger } from '@narada/shared';
import { LocalBlobStore } from '@narada/storage';
import { createWorkerLoop } from './loop';

const SHUTDOWN_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  loadDotEnv();
  let config;
  try {
    config = loadWorkerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createLogger({ name: 'ingestion-worker', level: config.LOG_LEVEL });
  const handle = createDatabase(config.DATABASE_URL, {
    onPoolError: (error) => logger.error({ err: error }, 'Idle database connection error'),
  });

  const worker = createWorkerLoop(
    handle.db,
    {
      db: handle.db,
      blobs: new LocalBlobStore(config.BLOB_STORE_DIR),
      logger,
      heartbeatMs: config.WORKER_HEARTBEAT_MS,
      limits: {
        ...DEFAULT_EXTRACTION_LIMITS,
        maxBytes: config.MAX_UPLOAD_BYTES,
        maxPages: config.PDF_MAX_PAGES,
        timeoutMs: config.EXTRACTION_TIMEOUT_MS,
      },
      chunking: {
        targetTokens: config.CHUNK_TARGET_TOKENS,
        maxTokens: config.CHUNK_MAX_TOKENS,
        overlapTokens: config.CHUNK_OVERLAP_TOKENS,
      },
    },
    {
      pollIntervalMs: config.WORKER_POLL_INTERVAL_MS,
      staleJobMs: config.WORKER_STALE_JOB_MS,
      maxAttempts: config.WORKER_MAX_ATTEMPTS,
    },
    logger,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down: finishing the in-flight job');
    const force = setTimeout(() => {
      logger.error('Shutdown timed out; forcing exit (the job will be recovered as stale)');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    await worker.stop();
    await handle.close();
    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  worker.start();
  logger.info({ blobStore: config.BLOB_STORE_DIR }, 'ingestion worker started');
}

main().catch((error: unknown) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});
