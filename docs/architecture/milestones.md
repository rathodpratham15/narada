# Implementation plan

Each milestone ends with: passing typecheck, passing tests (real Postgres/Redis for integration),
README and architecture docs updated, and a written report.

| # | Milestone | Delivers | Status |
|---|---|---|---|
| M1 | **Foundation and source registry** | Monorepo, config validation, Docker Compose (pgvector, Redis), Drizzle schema + migrations for all tables, DB constraint tests, source-registry service, Fastify API skeleton with request IDs, error handler, `/health`, `POST /v1/sources` | **done** (74 tests passing) |
| M2 | **Extraction, chunking and ingestion workflow** | Normalized document model; PDF (per page, OCR detection), TXT, Markdown extractors; structural chunker with overlap and deterministic ids; blob store; upload validation; `POST /v1/documents`, `GET /v1/documents/:id`, retry; Postgres-claimed job queue with heartbeat and stale-job recovery; worker process | **done** (237 tests passing) |
| M3 | **Embeddings** | `EmbeddingProvider` interface, OpenAI `fetch` adapter, batching, retry/backoff, dimension validation, usage metadata, fake provider, model registry + per-model HNSW index helper | |
| M4 | **Embedding stage, queue transport, worker health** | Add the `embed` stage to the pipeline (embed only chunks missing an embedding for the active model), Redis/BullMQ wake-up transport, `/health/ready` with Redis, worker health endpoint. *Upload API, blob store, retry, idempotency and stale-job recovery moved into M2 (ADR 0009).* | |
| M5 | **Retrieval** | Semantic, keyword, hybrid search; `POST /v1/search`; attribution and quotation-gating tests | |
| M6 | **Operational hardening and docs** | Rate limiting, helmet, worker health + heartbeat, graceful shutdown tests, end-to-end test from a clean clone following the README | |

## M2 scope notes

- **Pulled forward from M4** because the M2 workflow ("submitted → registered → extracted → chunked → stored → status
  queried") needs them: blob store, upload validation, document endpoints, retry, job processor, stale-job recovery.
- **Queue:** jobs are claimed from PostgreSQL with `FOR UPDATE SKIP LOCKED` instead of BullMQ (ADR 0009). BullMQ returns in
  M4 only as a wake-up transport.
- **Migrations:** `0002_chunk_provenance` (chunk provenance columns, drops the wrong `storage_key` uniqueness) and
  `0003_page_relative_offsets` (fixes an offsets constraint found by manual verification; 0002 was already applied, so a new
  migration was added rather than editing history).
- **Not in M2, by design:** OCR, embeddings, search, LLM answers, crawling, knowledge graph, chat, MCP.
