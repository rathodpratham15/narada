# Database schema

PostgreSQL 17 + pgvector 0.8. All ids are `uuid` (`gen_random_uuid()`), all timestamps `timestamptz`.
Text is stored as UTF-8; no column truncates source content.

## Enums

- `source_type`: `book | scripture | article | paper | web_page | report | other`
- `license_kind`: `public_domain | cc0 | cc_by | cc_by_sa | cc_by_nc | licensed | permission_granted | proprietary | unknown`
- `ingestion_status`: `PENDING | PROCESSING | COMPLETED | FAILED`

## sources

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| title | text NOT NULL | CHECK non-blank |
| author, publisher, edition | text NULL | never defaulted |
| source_type | source_type NOT NULL | |
| original_url | text NULL | CHECK `^https?://` |
| original_language | text NULL | BCP-47, CHECK loose pattern |
| publication_date | text NULL | `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (partial dates are common) |
| license_kind | license_kind NOT NULL | |
| license_url, license_notes | text NULL | |
| allow_indexing / allow_quotation / allow_redistribution | boolean NOT NULL DEFAULT false | |
| content_checksum | text NULL | optional *declared* sha256 of the canonical artifact; verified on upload |
| created_at, updated_at | timestamptz NOT NULL | |

Constraints:
- `UNIQUE NULLS NOT DISTINCT (title, author, publisher, edition)` blocks accidental double registration.
- `CHECK (allow_indexing = false OR license_kind NOT IN ('unknown','proprietary'))`.
- `CHECK (license_kind NOT IN ('licensed','permission_granted') OR length(trim(license_notes)) > 0)`.
- `CHECK (allow_quotation = false OR allow_indexing = true)`; same for redistribution.
- `CHECK (content_checksum IS NULL OR content_checksum ~ '^[0-9a-f]{64}$')`.

## documents

A logical file belonging to a source (a source may have many, e.g. volumes).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| source_id | uuid NOT NULL FK → sources ON DELETE RESTRICT | |
| title | text NOT NULL | |
| title_origin | text NOT NULL | `declared | extracted | filename` — records where the title came from |
| original_language | text NULL | declared only |
| created_at, updated_at | timestamptz | |

## document_versions

Immutable once written (except extraction summary fields set by the worker).

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| document_id | uuid NOT NULL FK → documents RESTRICT | |
| source_id | uuid NOT NULL FK → sources RESTRICT | denormalised for the idempotency index |
| version_number | integer NOT NULL | CHECK > 0 |
| content_sha256 | text NOT NULL | CHECK 64 lowercase hex |
| byte_size | bigint NOT NULL | CHECK > 0 |
| mime_type | text NOT NULL | validated by sniffing, not trusted from client |
| original_filename | text NULL | metadata only, never used as a path |
| storage_key | text NOT NULL | blob address of the untouched original. **Not unique:** identical bytes under two sources share one content-addressed blob (migration 0002) |
| page_count | integer NULL | set by extraction |
| extracted_title | text NULL | set by extraction |
| detected_language | text NULL | set by extraction, with `detected_language_confidence real NULL` |
| extraction_meta | jsonb NULL | `{method, status: ok\|failed, warnings[], pages{total,text,blank[],imageOnly[]}, offsetBasis, encoding, author}`; on failure also `error{code,message,details}` |
| chunking_config | jsonb NULL | exact chunking settings that produced the stored chunks: `{chunkerVersion, targetTokens, maxTokens, overlapTokens, tokenCounter}` |
| created_at | timestamptz | |

Indexes: `UNIQUE (document_id, version_number)`, `UNIQUE (source_id, content_sha256)` ← idempotency key.

## chunks

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| document_version_id | uuid NOT NULL FK ON DELETE CASCADE | chunks belong to a version |
| document_id, source_id | uuid NOT NULL FK RESTRICT | denormalised for filtering |
| chunk_index | integer NOT NULL | CHECK >= 0 |
| content | text NOT NULL | CHECK non-blank |
| content_sha256 | text NOT NULL | |
| token_estimate | integer NOT NULL | |
| page_start, page_end | integer NULL | CHECK `page_end >= page_start` |
| heading_path | text[] NOT NULL DEFAULT '{}' | e.g. `{"Chapter 2","Section 2.1"}` |
| section_id | text NULL | ordinal path derived from heading order, e.g. `1.2.1`; null before the first heading |
| char_start, char_end | integer NULL | UTF-16 offsets of the **blocks** the chunk draws from (block granularity, not exact characters) |
| offset_basis | text NULL | `document_text` (offsets into the decoded source text, BOM removed) or `page_text` (page-relative, see below) |
| extraction_method | text NOT NULL | e.g. `pdf-text@1.0.0+pdfjs-6.5.438` |
| chunker_version | text NOT NULL | e.g. `structural-v1` |
| chunking_config_hash | text NOT NULL | 16-hex hash of the chunking configuration and token counter name |
| locator | jsonb NOT NULL | discriminated union: `page`, `page_range`, `text_range` produced today; `section`, `verse`, `commentary` reserved |
| language | text NULL | |
| content_tsv | tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED | |
| created_at | timestamptz | |

Indexes: `UNIQUE (document_version_id, chunk_index)`, GIN on `content_tsv`, btree on `source_id`, `document_id`.

Offset constraints (migration 0003): `chunks_offsets_paired`: `char_start`, `char_end` and `offset_basis` are all null or all
set. `chunks_offsets_valid`: both non-negative, and `char_end >= char_start` **unless** `offset_basis = 'page_text'` and
`page_end > page_start`. For paged documents, offsets are relative to each page's own text, so a chunk spanning pages starts
on page N and ends on a later page, and its end offset can legitimately be smaller than its start offset.

Chunk ids are **deterministic** UUIDs derived from `(document_version_id, chunker_version, config_hash, chunk_index,
content_sha256)`, so reprocessing identical input yields identical rows.

## embedding_models

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| provider | text NOT NULL | e.g. `openai` |
| model | text NOT NULL | e.g. `text-embedding-3-small` |
| dimensions | integer NOT NULL | CHECK between 1 and 16000 |
| UNIQUE | (provider, model, dimensions) | |

## chunk_embeddings

| Column | Type | Notes |
|---|---|---|
| chunk_id | uuid FK → chunks ON DELETE CASCADE | |
| embedding_model_id | uuid FK → embedding_models RESTRICT | |
| dimensions | integer NOT NULL | |
| embedding | vector NOT NULL | untyped dimension; see ADR 0004 |
| prompt_tokens | integer NULL | usage metadata when the provider reports it |
| created_at | timestamptz | |
| PK | (chunk_id, embedding_model_id) | |
| CHECK | `vector_dims(embedding) = dimensions` | dimension validation at the database |

ANN index: one **partial HNSW index per model**, created when a model is registered:
`CREATE INDEX ... USING hnsw ((embedding::vector(N)) vector_cosine_ops) WHERE embedding_model_id = '<id>'`.
Queries use the identical expression so the planner can use it. `ensureVectorIndex(model)` in
`packages/database` owns this DDL. pgvector's HNSW limit is 2000 dimensions for `vector`; larger models
need `halfvec` or reduced dimensions (OpenAI `dimensions` parameter).

## ingestion_jobs

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | also the BullMQ job id (idempotent enqueue) |
| document_version_id | uuid NOT NULL FK RESTRICT | |
| status | ingestion_status NOT NULL DEFAULT 'PENDING' | |
| stage | text NULL | `extract | chunk | embed | store` |
| attempt | integer NOT NULL DEFAULT 0 | |
| retry_of_job_id | uuid NULL FK → ingestion_jobs | manual retry lineage |
| embedding_model_id | uuid NULL FK | model used |
| error_code, error_message | text NULL | |
| error_details | jsonb NULL | |
| queued_at, started_at, finished_at, heartbeat_at | timestamptz NULL | |
| created_at, updated_at | timestamptz | |

Constraints:
- `CHECK (status <> 'FAILED' OR (error_code IS NOT NULL AND error_message IS NOT NULL))`
- `CHECK (status <> 'COMPLETED' OR finished_at IS NOT NULL)`
- Partial unique index `ON (document_version_id) WHERE status IN ('PENDING','PROCESSING')`: at most one active job per version.
- Index on `(status, heartbeat_at)` for the stuck-job sweeper.

## Migration history

| Migration | Purpose |
|---|---|
| `0000_enable_pgvector` | `CREATE EXTENSION vector` (hand-written) |
| `0001_initial_schema` | All M1 tables, enums, constraints, indexes |
| `0002_chunk_provenance` | Chunk provenance columns (section, offsets, extraction method, chunker version, config hash), `document_versions.chunking_config`, drops `storage_key` uniqueness. The three `NOT NULL` columns use a temporary default so the migration also succeeds on databases that already hold chunks |
| `0003_page_relative_offsets` | Replaces `chunks_offsets_consistent` with `chunks_offsets_paired` + `chunks_offsets_valid` (cross-page chunks). Found by running a real PDF through the pipeline |

Applied migrations are never edited; changes are always new migrations.
