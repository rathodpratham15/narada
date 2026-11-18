# 0004 — Embedding model registry and per-model vector indexes

Status: accepted

**Decision.** `embedding_models` registers (provider, model, dimensions). `chunk_embeddings` stores an
untyped-dimension `vector` plus `dimensions`, guarded by `CHECK (vector_dims(embedding) = dimensions)`. An HNSW index
is created per model as a partial expression index `((embedding::vector(N)))` `WHERE embedding_model_id = …`.

**Why.** A typed `vector(1536)` column would hard-code one provider's dimension, contradicting the requirement that
future providers may differ. Multiple models can coexist during a migration to a better model, and chunks are not
re-chunked when the embedding model changes.

**Consequences.** Search queries must use the same cast expression and `embedding_model_id` filter. HNSW on `vector`
is limited to 2000 dimensions; larger models need `halfvec` or reduced output dimensions. Index creation is DDL, so it
runs through an explicit helper, not on the request path.
