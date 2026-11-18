# 0008 — Integration tests run against Docker Compose services

Status: accepted

**Decision.** Integration tests use the compose Postgres (pgvector) and Redis, with a dedicated `narada_test`
database that is created and migrated by test setup. No Testcontainers.

**Why.** Testcontainers 12 needs Node ≥ 22.22 and adds moving parts; compose is already the documented dev
workflow, so tests exercise the same images users run. Tests never touch the dev database.
