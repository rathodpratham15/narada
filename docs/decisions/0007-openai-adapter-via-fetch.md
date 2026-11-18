# 0007 — OpenAI embeddings adapter uses `fetch`, not the SDK

Status: accepted

**Decision.** The adapter calls `POST /v1/embeddings` directly with Node's `fetch`.

**Why.** One endpoint is all we need. Raw HTTP gives full control over retry classification (429/5xx/timeouts,
`Retry-After`), error mapping and usage metadata, makes the adapter trivially testable with a local HTTP server, and
removes a large dependency from the trust boundary.
