# Narada Knowledge Engine — Architecture

Status: proposal accepted for Milestone 1. Updated at the end of every milestone.

## Scope

The Knowledge Engine is the shared foundation for Narada AI, Narada Code and Narada MCP.
This slice does one thing: **ingest documents with provenance and retrieve passages with
accurate, verifiable source references.** It generates no answers.

## System shape

A modular monolith in a pnpm/Turborepo workspace, with two deployable processes:

```
 client ──HTTP──▶ apps/api (Fastify) ───────────────▶ PostgreSQL + pgvector
                    │   ▲                                   ▲
                    │   │ status                            │ chunks, embeddings,
          enqueue   ▼   │                                   │ job state
                  Redis (BullMQ) ──▶ workers/ingestion-worker
                                        │  extract → chunk → embed → store
                                        ▼
                              BlobStore (original files, content-addressed)
```

PostgreSQL is the source of truth for all state, including job state. BullMQ only delivers work.
If Redis loses the queue, a sweeper re-enqueues from `ingestion_jobs`.

## Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `shared` | Branded IDs, error types, logger factory, hashing, result helpers | — |
| `config` | Zod-validated environment, one `loadConfig()` per process | shared |
| `database` | Drizzle schema, migrations, client factory, vector column type, index helper | shared |
| `source-registry` | Source CRUD, licence/permission rules | database, shared |
| `storage` | `BlobStore` interface + local filesystem implementation (content-addressed) | shared |
| `ingestion` | Upload validation, extractors (pdf/txt/md), chunkers, pipeline orchestration | database, storage, embeddings |
| `embeddings` | `EmbeddingProvider` interface, OpenAI adapter, fake provider, retry, validation | shared |
| `queue` | Queue/job names, payload schemas, producer, sweeper | shared, database |
| `retrieval` | Semantic, keyword and hybrid (RRF) search; attribution assembly | database, embeddings |
| `test-utils` | (dev only) test database helpers, truncation, row fixtures | database, shared |
| `tests/integration` | (dev only) cross-package tests, e.g. database constraints; end-to-end tests in M6 | database, test-utils |
| `apps/api` | HTTP layer only: validation, routing, error mapping, no business logic | all above |
| `workers/ingestion-worker` | BullMQ consumer, heartbeat, health endpoint, graceful shutdown | ingestion, queue |

Deviation from the suggested layout: added `storage` and `queue`. Both have a seam that will
change (S3 for blobs, other queue backends) and both are used by two processes.

## Ingestion lifecycle

```
POST /v1/documents ─▶ validate (size, magic bytes, source permissions)
   ├─ sha256 matches an existing version of this source ─▶ 200, deduplicated, no new job
   └─ new content ─▶ store original blob ─▶ txn: document + version + job(PENDING) ─▶ enqueue
worker:  PENDING ─▶ PROCESSING ─▶ COMPLETED
                         └──────▶ FAILED (error_code, message, details recorded)
         stages: extract ─▶ chunk ─▶ embed ─▶ store
retry:   POST /v1/documents/:id/retry creates a NEW job row (history preserved)
```

Idempotency: the unique key is `(source_id, content_sha256)`. The worker replaces a version's chunks
inside a transaction, and embedding only fills chunks that lack an embedding for the active model,
so a retry never duplicates rows and never pays twice for the same chunk.

Versioning: new content for an existing document creates `document_versions` row N+1. Old versions,
chunks and embeddings stay. Search only reads the latest COMPLETED version of each document, but
every result carries `documentVersionId` so a citation stays resolvable after updates.

## Provenance rules (enforced in code and schema)

1. Citation fields are copied from `sources` / `chunks` rows at query time. Nothing is generated.
2. Absent metadata stays `NULL` and is returned as `null`. No defaults like "Unknown author".
3. A chunk always has `source_id`, `document_version_id`, `chunk_index`, a `locator`, and page and/or
   heading info when the extractor produced it.
4. The original bytes are stored untouched, addressed by sha256.
5. Retrieved text is data. API responses mark it as such, and any future answer layer must delimit
   it and never execute instructions found inside it.

## Legal gate

A source declares licence kind and three permissions: `allowIndexing`, `allowQuotation`,
`allowRedistribution`. Rules, enforced by DB CHECK constraints and service code:

- Ingestion is refused unless `allowIndexing = true`.
- `allowIndexing = true` is impossible for licence kinds `unknown` and `proprietary`.
- `licensed` and `permission_granted` require non-empty `licenseNotes` (evidence reference).
- If `allowQuotation = false`, search returns the citation but withholds the passage text.

The engine records and enforces what the registrant declares. It cannot verify a legal claim.

## Multilingual and structured-text readiness

- `locator` is a JSONB discriminated union: `{kind:"page"}` now, with `{kind:"verse", work, book,
  chapter, verse}` and `{kind:"commentary", on, author}` reserved for structured texts.
- `Chunker` is an interface over a `StructuredDocument` (sections → blocks), so a verse-aware chunker
  is an additional implementation, not a rewrite.
- Language is stored as BCP-47 text at source, document and chunk level. Declared and detected
  values are kept separately.
- Keyword search uses the `simple` text-search configuration (no English stemming) so it does not
  damage other languages. See risk R4 for Devanagari caveats.
- Embedding dimensions are per model, never global (ADR 0004).

## Operational foundations

Structured JSON logs (pino) with a request ID per request, propagated into queue payloads; central
error handler returning one error envelope; Zod validation at every boundary; `/health` (liveness)
and `/health/ready` (DB + Redis); worker heartbeat in `ingestion_jobs.heartbeat_at` plus its own
`/health`; SIGTERM drains in-flight jobs; environment validated at boot, process exits on invalid
config.

## Related documents

- [Schema](schema.md) · [API contracts](api.md) · [Risks](risks.md) · [Milestones](milestones.md)
- Decisions: `docs/decisions/`
