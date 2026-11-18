# Narada Knowledge Engine

Provenance-preserving document ingestion and retrieval. The shared foundation for Narada AI, Narada Code
and Narada MCP. It retrieves passages with verifiable source references and **does not generate answers**.

**Status: Milestone 2 of 6 — document extraction and structural chunking.** See
[`docs/architecture/milestones.md`](docs/architecture/milestones.md).

| Works today | Not yet built |
|---|---|
| Source registry with licence/permission rules (`POST /v1/sources`) | Embeddings (M3) |
| Upload PDF / TXT / Markdown (`POST /v1/documents`), original bytes preserved and checksummed | Semantic and keyword search (M5) |
| Idempotent ingestion, document versions, retry of failed jobs | OCR for scanned PDFs (not planned for M1–M6) |
| Extraction with page numbers, headings, lists, tables, code, warnings | Redis/BullMQ transport, worker health endpoint (M4/M6) |
| Structural, deterministic chunking with full source locations | Authentication |
| Job status API (`GET /v1/documents/:id`), failures recorded and observable | |

## Prerequisites

- **Node.js 22** (`>=22.12`; `.nvmrc` pins 22.23.2). Node 20 will not work: several dependencies require 22.
- **pnpm 10** (`corepack enable` or `npm i -g pnpm`)
- **Docker** with Compose v2

```bash
nvm install && nvm use      # picks the version in .nvmrc
```

## Setup

```bash
pnpm install
cp .env.example .env        # defaults work with the Docker services below
pnpm infra:up               # PostgreSQL 17 + pgvector (host port 5433) and Redis (host port 6380)
pnpm db:migrate             # applies migrations to the development database
```

Ports 5433/6380 are deliberately not the defaults, so a locally installed Postgres or Redis does not collide.
Override with `NARADA_PG_PORT` / `NARADA_REDIS_PORT` and update `.env` to match.

## Run

Ingestion has two processes, started in two terminals. Both load the repository-root `.env` automatically
(variables already set in your shell win). **They must share the same `BLOB_STORE_DIR`**, which defaults to
`.data/blobs` at the repository root.

```bash
pnpm dev:api                # http://127.0.0.1:3000  (accepts uploads, serves status)
pnpm dev:worker             # extracts, chunks and stores
```

### Try it

```bash
# 1. register a source. Indexing must be allowed, and you declare the legal basis
SRC=$(curl -s -X POST localhost:3000/v1/sources -H 'content-type: application/json' -d '{
  "title": "Example Public Domain Text",
  "sourceType": "book",
  "originalLanguage": "en",
  "license": { "kind": "public_domain", "notes": "Author died 1920." },
  "permissions": { "allowIndexing": true, "allowQuotation": true, "allowRedistribution": true }
}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["source"]["id"])')

# 2. upload a .pdf, .txt, .md or .markdown file  → 202, job PENDING
curl -s -F "sourceId=$SRC" -F "file=@/path/to/document.pdf" localhost:3000/v1/documents

# 3. poll status: PENDING → PROCESSING → COMPLETED | FAILED (with an error code and message)
curl -s localhost:3000/v1/documents/<document-id>

# 4. if it FAILED, fix the cause and retry (a new job is created; the failed one stays as history)
curl -s -X POST localhost:3000/v1/documents/<document-id>/retry
```

Re-uploading identical bytes for the same source returns `200` with `"deduplicated": true` and creates nothing.
To add a new version of an existing document, send its `documentId` as an extra form field.
Full contracts: [`docs/architecture/api.md`](docs/architecture/api.md).

## Test

```bash
pnpm typecheck
pnpm test:unit              # no services needed
pnpm test:integration       # needs `pnpm infra:up`; uses the separate `narada_test` database
pnpm test                   # both (237 tests)
```

Integration tests run against the real Docker Postgres/pgvector, with real PDFs generated in code (including
image-only and password-protected ones), a real on-disk blob store, the real API and the real worker loop.
They create and migrate `narada_test`, truncate it between tests, and refuse to run against any database whose name
does not contain "test".

## Useful commands

| Command | Purpose |
|---|---|
| `pnpm infra:up` / `infra:down` | Start / stop Postgres and Redis (data kept) |
| `pnpm infra:reset` | Stop and **delete** all local data volumes |
| `pnpm db:generate` | Generate a migration after editing `packages/database/src/schema.ts` |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |

## Repository layout

```
apps/api                    HTTP layer (Fastify): validation, routing, error mapping, no business logic
workers/ingestion-worker    Polls the job queue and runs the pipeline; graceful shutdown
packages/shared             Errors, logger, hashing, deterministic ids
packages/config             Zod-validated environment
packages/database           Drizzle schema, migrations, client
packages/source-registry    Sources, licence/permission rules, legal gate
packages/storage            BlobStore interface + content-addressed local implementation
packages/ingestion          Upload validation, extractors (pdf/txt/md), chunker, submit/retry/status, job processor
packages/test-utils         Test database helpers, fixtures, PDF generator (dev only)
tests/integration           Cross-package integration tests (database constraints, end-to-end ingestion)
infra/docker                docker-compose.yml, Postgres init scripts
docs/architecture           Current system design, schema, API, risks, milestones
docs/decisions              Architecture decision records
```

Packages for embeddings, queue transport and retrieval are added in the milestones that implement them; no
placeholder packages exist.

## Security notes

- **No authentication yet** (out of scope for this phase). Bind to localhost; do not expose the API publicly.
- Uploads are validated by extension **and** content (PDF header, no NUL bytes, no executable/archive signatures,
  consistent declared type), size-limited (`MAX_UPLOAD_BYTES`), and stored under a content hash: the client filename is
  never used as a path. PDFs are parsed only in the worker, with page, size and time limits.
- Retrieved or extracted text is data, never instructions. Error messages stored on jobs never contain SQL or document text.
- Secrets come only from environment variables. `.env` is git-ignored; `.env.example` contains no real values.

## Known limitations

These are real and measured, not hypothetical. Details and rationale are in
[`docs/architecture/risks.md`](docs/architecture/risks.md).

- **No OCR.** Scanned (image-only) PDFs fail with `OCR_REQUIRED` rather than being indexed as empty. A PDF where at least
  half the pages are images fails too, so the minority with text is never silently indexed alone.
- **PDF layout is heuristic.** Text is read in content-stream order (no column re-sorting); headings come from font size, so
  tables of contents and author lines can be mistaken for headings; tables in PDFs are not recognised as tables.
- **Line-end hyphenation is kept** (`ver-` / `sion` stay two fragments), because rejoining is ambiguous. On four real PDFs
  this is the only difference we found against Poppler: **98.7–100 % word recall** (`pdftotext` as the reference).
- **Text outside a PDF page's visible area is not extracted** (Poppler behaves the same).
- Chunk offsets bound the **blocks** a chunk draws from, not exact characters; for PDFs they are page-relative.
- Token counts are script-aware **estimates**, not a model tokenizer; they are replaced when embeddings land (M3).
- Markdown: front matter is skipped (with a warning); complex content nested inside list items is flattened.
- The worker polls PostgreSQL (default every second); there is no push wake-up or worker health endpoint yet.
- `/health/ready` checks PostgreSQL only; Redis joins when the API starts using it.
- Packages run from TypeScript source via `tsx`; there is no compiled build or container image yet.
- Sources can be created but not yet updated or listed.
