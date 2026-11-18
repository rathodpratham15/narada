-- Hand-edited after generation (migration not yet applied anywhere): the three NOT NULL provenance columns get a
-- temporary default so the migration also succeeds on databases that already contain chunk rows.
ALTER TABLE "document_versions" DROP CONSTRAINT "document_versions_storage_key_unique";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "section_id" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "char_start" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "char_end" integer;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "offset_basis" text;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "extraction_method" text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "extraction_method" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "chunker_version" text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "chunker_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "chunking_config_hash" text NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "chunks" ALTER COLUMN "chunking_config_hash" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "chunking_config" jsonb;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_offsets_consistent" CHECK (("chunks"."char_start" is null) = ("chunks"."char_end" is null) and ("chunks"."char_start" is null) = ("chunks"."offset_basis" is null) and ("chunks"."char_start" is null or ("chunks"."char_start" >= 0 and "chunks"."char_end" >= "chunks"."char_start")));--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_offset_basis_valid" CHECK ("chunks"."offset_basis" is null or "chunks"."offset_basis" in ('document_text', 'page_text'));