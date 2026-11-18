# Technical risks and open decisions

| # | Risk | Mitigation / decision |
|---|---|---|
| R1 | **Node version.** Current vitest 5, pdfjs-dist 6, openai 7, pgvector-node, file-type require Node ≥ 22. The default `node` on this machine is 20.18.2. | Target Node 22 (`.nvmrc` = 22.23.2, `engines >=22.12`). Documented in README. |
| R2 | **TypeScript 7 is the `latest` tag** (native rewrite); drizzle-kit, vitest and tsx tooling maturity unverified. | Pin `typescript ~5.9.3`. Revisit when tooling confirms 7 support. |
| R3 | **Drizzle 1.0 is still RC.** | Use stable `drizzle-orm 0.45.x` + `drizzle-kit 0.31.x`. Hand-written SQL for pgvector DDL. |
| R4 | **Keyword search quality on Indic scripts.** Postgres' default parser can mis-split Devanagari combining marks, and `simple` has no stemming. | `simple` config now; add `pg_trgm` index and/or a language-aware tokenizer when Indic corpora arrive. Covered by a test using Devanagari text so regressions are visible. **Verified in M1** on the `en_US.utf8` compose database: Devanagari tokens stay intact and match exactly, but matching is whole-token only: `धर्म` does not match `धर्मः`, and sandhi-joined words are single tokens. Semantic search must carry recall for inflected forms; behaviour depends on the database locale. |
| R5 | **Multiple embedding dimensions.** HNSW needs a fixed dimension; HNSW on `vector` caps at 2000. | Untyped `vector` column, `CHECK (vector_dims = dimensions)`, partial per-model HNSW index (ADR 0004). |
| R6 | **Malicious or pathological PDFs** (decompression bombs, huge page counts, parser exploits). | Extraction only in the worker, never the API; pdfjs with eval and scripting off; page-count and extracted-size limits; per-job timeout. Residual risk: parser CVEs. Run worker unprivileged; container hardening later. |
| R7 | **Prompt injection via retrieved text.** | Retrieval returns data tagged `contentRole: retrieved_passage`; nothing is interpreted. The future answer layer must delimit it. Noted here so it is not forgotten. |
| R8 | **Copyright.** The engine cannot verify legal claims. | Registrant must declare licence and permissions; indexing is blocked without `allowIndexing`; DB checks make contradictory states unrepresentable; quotation permission gates passage text. No bundled corpora. |
| R9 | **PDF text extraction is lossy** (columns, scanned pages, ligatures, Indic fonts with broken ToUnicode maps). | Per-page extraction with warnings recorded in `extraction_meta`; pages with no text are recorded, **never silently dropped**. A document with zero extractable text FAILS with `NO_EXTRACTABLE_TEXT` (OCR is out of scope). |
| R10 | **Queue/DB divergence.** | Postgres is truth; BullMQ job id = job row id; sweeper re-enqueues stale PENDING and fails/requeues stuck PROCESSING based on `heartbeat_at`. |
| R11 | **Embedding cost and rate limits.** | Batching, bounded concurrency, exponential backoff with jitter honouring `Retry-After`, embed-only-missing on retry. |
| R12 | **No authentication yet** (explicitly out of scope) but the API accepts uploads. | Bind to localhost by default, documented as development-only. Optional shared `NARADA_API_TOKEN` bearer guard in Milestone 6 is a deployment safeguard, not user auth. |
| R13 | **Local port collisions.** A Homebrew Redis already listens on 6379 on this machine. | Compose maps Postgres → 5433 and Redis → 6380 (configurable). |

## Decisions recorded as ADRs

0001 monorepo and toolchain · 0002 Postgres as source of truth, BullMQ as transport ·
0003 content-addressed blob storage · 0004 embedding model registry and per-model vector indexes ·
0005 licence and permission gate · 0006 hybrid retrieval with reciprocal-rank fusion ·
0007 raw `fetch` OpenAI adapter instead of SDK · 0008 integration tests via Docker Compose
