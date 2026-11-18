# Implementation plan

Each milestone ends with: passing typecheck, passing tests (real Postgres/Redis for integration),
README and architecture docs updated, and a written report.

| # | Milestone | Delivers | Status |
|---|---|---|---|
| M1 | **Foundation and source registry** | Monorepo, config validation, Docker Compose (pgvector, Redis), Drizzle schema + migrations for all tables, DB constraint tests, source-registry service, Fastify API skeleton with request IDs, error handler, `/health`, `POST /v1/sources` | **done** (74 tests passing) |
| M2 | **Extraction and chunking** | Extractor interface; PDF (per page), TXT, Markdown (headings) extractors; configurable overlap chunker over a structured document model; failure surfacing; fixtures and unit tests | |
| M3 | **Embeddings** | `EmbeddingProvider` interface, OpenAI `fetch` adapter, batching, retry/backoff, dimension validation, usage metadata, fake provider, model registry + per-model HNSW index helper | |
| M4 | **Ingestion pipeline, upload API, worker** | BlobStore, upload validation, `POST /v1/documents`, `GET /v1/documents/:id`, retry endpoint, BullMQ producer/worker, state machine, idempotency, duplicate handling, sweeper | |
| M5 | **Retrieval** | Semantic, keyword, hybrid search; `POST /v1/search`; attribution and quotation-gating tests | |
| M6 | **Operational hardening and docs** | Rate limiting, helmet, worker health + heartbeat, graceful shutdown tests, end-to-end test from a clean clone following the README | |
