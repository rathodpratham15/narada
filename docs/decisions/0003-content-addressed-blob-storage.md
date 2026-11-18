# 0003 — Content-addressed blob storage for originals

Status: accepted

**Decision.** Original uploads are stored untouched under `sha256/<aa>/<hash>` through a `BlobStore` interface; the
local-filesystem implementation ships first. The client filename is stored as metadata only and never becomes a path.

**Why.** Provenance requires the exact original bytes; content addressing makes writes idempotent and removes
path-traversal risk; the interface allows S3 later.
