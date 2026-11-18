# API contracts (v1)

All bodies are JSON unless noted. Every response carries an `x-request-id` header (client-supplied
value is honoured if it is a valid UUID or ≤ 64 safe characters, otherwise generated).

## Error envelope

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "requestId": "…", "details": {} } }
```

| HTTP | code examples |
|---|---|
| 400 | `VALIDATION_ERROR`, `INVALID_FILE_TYPE`, `CHECKSUM_MISMATCH` |
| 403 | `INDEXING_NOT_PERMITTED` |
| 404 | `SOURCE_NOT_FOUND`, `DOCUMENT_NOT_FOUND` |
| 409 | `SOURCE_ALREADY_EXISTS` (includes `existingSourceId`), `RETRY_NOT_ALLOWED` |
| 413 | `FILE_TOO_LARGE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL_ERROR` (no internals leaked) |
| 502 | `EMBEDDING_PROVIDER_ERROR` (search-time query embedding failure) |

## GET /health, GET /health/ready

`/health` → `200 {"status":"ok"}` (process alive). `/health/ready` → `200` or `503` with per-dependency
status for PostgreSQL and Redis.

## POST /v1/sources

```json
{
  "title": "Valmiki Ramayana, Book 1",          // required
  "author": "Valmiki",                          // optional, never defaulted
  "publisher": null,
  "sourceType": "scripture",                    // required
  "originalUrl": "https://example.org/…",       // optional
  "originalLanguage": "sa",                     // optional BCP-47
  "publicationDate": "1891",                    // optional YYYY | YYYY-MM | YYYY-MM-DD
  "edition": null,
  "license": { "kind": "public_domain", "url": null, "notes": "Translator died 1920." },
  "permissions": { "allowIndexing": true, "allowQuotation": true, "allowRedistribution": true },
  "contentChecksum": null                       // optional declared sha256
}
```

→ `201 { "source": { id, …all fields…, createdAt, updatedAt } }`. Duplicate → `409 SOURCE_ALREADY_EXISTS`.

## POST /v1/documents (multipart/form-data)

Fields: `sourceId` (required), `title`, `language` (BCP-47), `documentId` (supply to add a new version
to an existing document), `file` (required; `.pdf`, `.txt`, `.md`, `.markdown`; default max 25 MB).

- New content → `202 { document, version, job: { id, status: "PENDING" }, deduplicated: false }`
- Identical bytes already ingested for this source → `200 { document, version, job: <latest job>, deduplicated: true }`
- Source without `allowIndexing` → `403 INDEXING_NOT_PERMITTED`
- Declared source `contentChecksum` ≠ computed → `400 CHECKSUM_MISMATCH`

## GET /v1/documents/:id

```json
{
  "document": { "id", "sourceId", "title", "titleOrigin", "originalLanguage", "createdAt", "updatedAt" },
  "latestVersion": { "id", "versionNumber", "contentSha256", "byteSize", "mimeType", "originalFilename",
                     "pageCount", "extractedTitle", "detectedLanguage" },
  "latestJob": { "id", "status", "stage", "attempt", "error": { "code", "message", "details" } | null,
                 "queuedAt", "startedAt", "finishedAt" },
  "chunkCount": 0,
  "versions": [ { "id", "versionNumber", "createdAt" } ]
}
```

## POST /v1/documents/:id/retry

Allowed only when the latest job is `FAILED`. Creates a new job row linked by `retry_of_job_id`.
→ `202 { job }`, otherwise `409 RETRY_NOT_ALLOWED`.

## POST /v1/search

```json
{
  "query": "Why did Rama accept exile?",         // 1–2000 chars
  "mode": "hybrid",                              // "semantic" | "keyword" | "hybrid" (default)
  "limit": 10,                                   // 1–50
  "filters": { "sourceIds": ["…"], "documentIds": ["…"], "language": "en" }
}
```

```json
{
  "query": "…", "mode": "hybrid",
  "embeddingModel": { "provider": "openai", "model": "text-embedding-3-small", "dimensions": 1536 },
  "results": [{
    "chunkId": "…", "documentId": "…", "documentVersionId": "…",
    "sourceId": "…", "sourceTitle": "…", "sourceAuthor": null, "edition": null,
    "originalUrl": null, "license": "public_domain",
    "passage": "…", "passageWithheld": false,
    "location": { "pageStart": 12, "pageEnd": 12, "headingPath": ["Chapter 2"], "locator": { "kind": "page", "page": 12 } },
    "score": 0.83,
    "scores": { "semantic": 0.83, "keyword": null, "fused": null },
    "contentRole": "retrieved_passage"
  }],
  "timingMs": 41
}
```

Semantic `score` = cosine similarity (1 − cosine distance). Keyword = `ts_rank_cd`. Hybrid = reciprocal-rank
fusion score (not comparable across modes; each mode reports its own raw scores under `scores`).
Only the latest COMPLETED version of each document is searched. When `allowQuotation` is false,
`passage` is `null` and `passageWithheld` is `true`; the citation is still returned.
`contentRole: "retrieved_passage"` marks the text as untrusted data for any downstream consumer.
