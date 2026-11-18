# 0009 — Jobs are claimed from PostgreSQL in M2; BullMQ is deferred

Status: accepted. Amends [0002](0002-postgres-source-of-truth-bullmq-transport.md).

**Context.** The M2 workflow needs a background worker, but not Redis: PostgreSQL already holds all job state.

**Decision.** The worker claims the oldest `PENDING` job with a single `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED
LIMIT 1) RETURNING id`, sets `PROCESSING`, increments `attempt`, and heartbeats `heartbeat_at` while it runs. `recoverStaleJobs`
re-queues jobs whose heartbeat is stale, and fails them with `WORKER_LOST` once `attempt` reaches the maximum. A job is
marked `COMPLETED` in the same transaction that stores its chunks, and every state change is guarded by `status = 'PROCESSING'`,
so a worker that lost its job can never overwrite newer state. Retries create a new job row (`retry_of_job_id`).

**Consequences.**
- No enqueue/commit divergence is possible (there is no second system to disagree with the database).
- Any number of workers may poll concurrently; a test claims six jobs from six concurrent callers and gets six distinct ids.
- Latency is up to one poll interval. M4 may add BullMQ purely as a wake-up signal; PostgreSQL stays the source of truth.
