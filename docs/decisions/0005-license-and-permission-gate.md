# 0005 — Licence and permission gate

Status: accepted

**Decision.** Sources must declare licence kind and three permissions (indexing, quotation, redistribution).
Contradictory combinations are rejected by database CHECK constraints (see schema.md). Ingestion requires
`allowIndexing`. Search withholds passage text when `allowQuotation` is false.

**Why.** The brief forbids ingesting copyrighted material without a legal basis. Encoding the rule in the schema makes
the unsafe state unrepresentable even if a service bug or a direct SQL write tries it.

**Limits.** The system records declarations; it cannot verify them.
