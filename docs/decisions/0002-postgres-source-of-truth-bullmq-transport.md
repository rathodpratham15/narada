# 0002 — PostgreSQL is the source of truth; BullMQ is transport

Status: accepted

**Decision.** Job state lives in `ingestion_jobs`. BullMQ delivers work, using the job row id as the BullMQ job id.
A sweeper re-enqueues stale PENDING jobs and recovers PROCESSING jobs whose `heartbeat_at` is stale.

**Why.** Redis can lose data; users query job state from the API; retries and errors need durable audit history.

**Consequences.** Every state transition is a SQL update guarded by the expected current status. Enqueue is
idempotent through the shared id.
