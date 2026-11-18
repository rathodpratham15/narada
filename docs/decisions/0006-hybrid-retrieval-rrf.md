# 0006 — Hybrid retrieval with reciprocal-rank fusion

Status: accepted

**Decision.** `semantic` (pgvector cosine), `keyword` (Postgres FTS, `simple` config, `ts_rank_cd`) and `hybrid`
(RRF, k = 60, over the top-N of each). Each result reports its raw per-mode scores.

**Why.** Semantic and lexical scores are not comparable; rank fusion needs no score calibration and works across
languages. Keyword search keeps exact names and verse references findable.
