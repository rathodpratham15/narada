# Narada Knowledge Engine

Provenance-preserving document ingestion and retrieval: the shared foundation for Narada AI, Narada Code
and Narada MCP. It retrieves passages with verifiable source references and does not generate answers.

This branch holds the **repository structure only**: architecture docs, decision records, infrastructure
definition and workspace tooling. Implementation lands milestone by milestone on feature branches
(see `docs/architecture/milestones.md`).

## Structure

```
apps/api                  HTTP layer (Fastify)
packages/shared           Errors, logger, hashing
packages/config           Validated environment
packages/database         Drizzle schema and migrations
packages/source-registry  Sources, licence/permission rules
packages/test-utils       Test database helpers (dev only)
tests/integration         Cross-package integration tests
infra/docker              Docker Compose: PostgreSQL + pgvector, Redis
docs/architecture         System design, schema, API contracts, risks, milestones
docs/decisions            Architecture decision records
```

Packages for extraction, chunking, embeddings, storage, queueing, retrieval and the ingestion worker are
added in the milestones that implement them.

Requires Node 22 (see `.nvmrc`), pnpm 10 and Docker.
