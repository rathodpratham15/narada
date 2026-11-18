import type { Database } from '@narada/database';
import { claimNextJob, processJob, recoverStaleJobs, type ProcessDeps, type ProcessOutcome } from '@narada/ingestion';

interface LoggerLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface WorkerOptions {
  pollIntervalMs: number;
  staleJobMs: number;
  maxAttempts: number;
  /** How often to look for jobs abandoned by crashed workers. */
  recoverIntervalMs?: number;
}

export interface WorkerLoop {
  /** Claims and processes at most one job. Returns null when nothing was pending. */
  runOnce(): Promise<ProcessOutcome | null>;
  start(): void;
  /** Stops polling and resolves once the in-flight job (if any) has finished. */
  stop(): Promise<void>;
}

export function createWorkerLoop(
  db: Database,
  processDeps: ProcessDeps,
  options: WorkerOptions,
  logger?: LoggerLike,
): WorkerLoop {
  let stopping = false;
  let running: Promise<void> | undefined;
  let wake: (() => void) | undefined;
  let lastRecovery = 0;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function recoverIfDue(): Promise<void> {
    const interval = options.recoverIntervalMs ?? 30_000;
    if (Date.now() - lastRecovery < interval) return;
    lastRecovery = Date.now();
    const result = await recoverStaleJobs(db, { staleAfterMs: options.staleJobMs, maxAttempts: options.maxAttempts });
    if (result.requeued || result.failed) logger?.warn(result, 'recovered stale ingestion jobs');
  }

  async function runOnce(): Promise<ProcessOutcome | null> {
    await recoverIfDue();
    const job = await claimNextJob(db);
    if (!job) return null;
    logger?.info({ jobId: job.id, attempt: job.attempt }, 'job claimed');
    return processJob(processDeps, job.id);
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      try {
        const outcome = await runOnce();
        if (outcome === null) await sleep(options.pollIntervalMs);
      } catch (error) {
        // e.g. database briefly unavailable: log, back off, keep the worker alive.
        logger?.error({ err: error }, 'worker iteration failed');
        await sleep(Math.max(options.pollIntervalMs, 1000));
      }
    }
  }

  return {
    runOnce,
    start() {
      if (running) return; // already running: starting twice must not spawn a second poller
      stopping = false; // a stopped worker can be started again
      running = loop();
    },
    async stop() {
      stopping = true;
      wake?.();
      await running;
      running = undefined;
    },
  };
}
