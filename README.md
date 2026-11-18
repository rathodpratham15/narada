# Narada Knowledge Engine

Provenance-preserving document ingestion and retrieval. The shared foundation for Narada AI, Narada Code
and Narada MCP. It retrieves passages with verifiable source references and **does not generate answers**.

**Status: Milestone 1 of 6 — foundation and source registry.** See [`docs/architecture/milestones.md`](docs/architecture/milestones.md).

| Works today | Not yet built |
|---|---|
| Source registry (`POST /v1/sources`) with licence/permission rules | Document upload and ingestion (M4) |
| Full database schema + migrations (sources, documents, versions, chunks, embeddings, jobs) | Extraction and chunking (M2) |
| API skeleton: request IDs, central error handling, health checks, graceful shutdown | Embeddings (M3) |
| Validated environment config | Search (M5) |

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

## Run the API

The API reads configuration from the process environment (it does not load `.env` itself):

```bash
set -a; source .env; set +a
pnpm dev:api                # http://127.0.0.1:3000, logs are JSON on stdout
```

```bash
curl -s localhost:3000/health
curl -s localhost:3000/health/ready

curl -s -X POST localhost:3000/v1/sources -H 'content-type: application/json' -d '{
  "title": "Example Public Domain Text",
  "author": "Example Author",
  "sourceType": "book",
  "originalLanguage": "en",
  "publicationDate": "1895",
  "license": { "kind": "public_domain", "notes": "Author died 1920." },
  "permissions": { "allowIndexing": true, "allowQuotation": true, "allowRedistribution": true }
}'
```

Omitted metadata is stored as `null`. Nothing is defaulted or guessed. A source that does not set
`allowIndexing` cannot be ingested later. Full contracts: [`docs/architecture/api.md`](docs/architecture/api.md).

## Test

```bash
pnpm typecheck
pnpm test:unit              # no services needed
pnpm test:integration       # needs `pnpm infra:up`; uses the separate `narada_test` database
pnpm test                   # both
```

Integration tests run against the real Docker Postgres/pgvector. They create and migrate `narada_test`, truncate
it between tests, and refuse to run against any database whose name does not contain "test".

## Useful commands

| Command | Purpose |
|---|---|
| `pnpm infra:up` / `infra:down` | Start / stop Postgres and Redis (data kept) |
| `pnpm infra:reset` | Stop and **delete** all local data volumes |
| `pnpm db:generate` | Generate a migration after editing `packages/database/src/schema.ts` |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |

## Repository layout

```
apps/api                  HTTP layer (Fastify): validation, routing, error mapping
packages/shared           Errors, logger, hashing
packages/config           Zod-validated environment
packages/database         Drizzle schema, migrations, client
packages/source-registry  Sources, licence/permission rules, legal gate
packages/test-utils       Test database helpers and fixtures (dev only)
tests/integration         Cross-package integration tests (database constraints)
infra/docker              docker-compose.yml, Postgres init scripts
docs/architecture         Current system design, schema, API, risks, milestones
docs/decisions            Architecture decision records
```

Packages for extraction, chunking, embeddings, storage, queueing, retrieval and the ingestion worker are added
in the milestones that implement them; no placeholder packages exist.

## Security notes

- **No authentication yet** (out of scope for this phase). Bind to localhost; do not expose the API publicly.
- Secrets come only from environment variables. `.env` is git-ignored; `.env.example` contains no real values.
- Config errors name the failing variable but never print its value.

## Known limitations (Milestone 1)

- Source records cannot be updated or listed yet; only created and read by id internally.
- `/health/ready` checks PostgreSQL only; Redis is added when the API starts using it (M4).
- Packages run from TypeScript source via `tsx` (no compiled build or container image yet).
- Keyword search will use whole-token matching without stemming; see risk R4 in `docs/architecture/risks.md`.
