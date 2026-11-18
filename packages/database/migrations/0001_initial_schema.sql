CREATE TYPE "public"."ingestion_status" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."license_kind" AS ENUM('public_domain', 'cc0', 'cc_by', 'cc_by_sa', 'cc_by_nc', 'licensed', 'permission_granted', 'proprietary', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('book', 'scripture', 'article', 'paper', 'web_page', 'report', 'other');--> statement-breakpoint
CREATE TABLE "chunk_embeddings" (
	"chunk_id" uuid NOT NULL,
	"embedding_model_id" uuid NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector NOT NULL,
	"prompt_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunk_embeddings_chunk_id_embedding_model_id_pk" PRIMARY KEY("chunk_id","embedding_model_id"),
	CONSTRAINT "chunk_embeddings_dimensions_match" CHECK (vector_dims("chunk_embeddings"."embedding") = "chunk_embeddings"."dimensions")
);
--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_version_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"token_estimate" integer NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"heading_path" text[] DEFAULT '{}'::text[] NOT NULL,
	"locator" jsonb NOT NULL,
	"language" text,
	"content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_version_index_unique" UNIQUE("document_version_id","chunk_index"),
	CONSTRAINT "chunks_index_non_negative" CHECK ("chunks"."chunk_index" >= 0),
	CONSTRAINT "chunks_content_not_blank" CHECK (length(btrim("chunks"."content")) > 0),
	CONSTRAINT "chunks_token_estimate_positive" CHECK ("chunks"."token_estimate" > 0),
	CONSTRAINT "chunks_page_order" CHECK ("chunks"."page_start" is null or "chunks"."page_end" is null or "chunks"."page_end" >= "chunks"."page_start"),
	CONSTRAINT "chunks_page_positive" CHECK ("chunks"."page_start" is null or "chunks"."page_start" > 0)
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"original_filename" text,
	"storage_key" text NOT NULL,
	"page_count" integer,
	"extracted_title" text,
	"detected_language" text,
	"detected_language_confidence" real,
	"extraction_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "document_versions_document_version_unique" UNIQUE("document_id","version_number"),
	CONSTRAINT "document_versions_source_content_unique" UNIQUE("source_id","content_sha256"),
	CONSTRAINT "document_versions_version_positive" CHECK ("document_versions"."version_number" > 0),
	CONSTRAINT "document_versions_byte_size_positive" CHECK ("document_versions"."byte_size" > 0),
	CONSTRAINT "document_versions_sha256_format" CHECK ("document_versions"."content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_versions_page_count_positive" CHECK ("document_versions"."page_count" is null or "document_versions"."page_count" > 0)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"title" text NOT NULL,
	"title_origin" text NOT NULL,
	"original_language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_title_not_blank" CHECK (length(btrim("documents"."title")) > 0),
	CONSTRAINT "documents_title_origin_valid" CHECK ("documents"."title_origin" in ('declared', 'extracted', 'filename')),
	CONSTRAINT "documents_original_language_bcp47" CHECK ("documents"."original_language" is null or "documents"."original_language" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$')
);
--> statement-breakpoint
CREATE TABLE "embedding_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_models_identity_unique" UNIQUE("provider","model","dimensions"),
	CONSTRAINT "embedding_models_dimensions_range" CHECK ("embedding_models"."dimensions" between 1 and 16000)
);
--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_version_id" uuid NOT NULL,
	"status" "ingestion_status" DEFAULT 'PENDING' NOT NULL,
	"stage" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"retry_of_job_id" uuid,
	"embedding_model_id" uuid,
	"error_code" text,
	"error_message" text,
	"error_details" jsonb,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_jobs_attempt_non_negative" CHECK ("ingestion_jobs"."attempt" >= 0),
	CONSTRAINT "ingestion_jobs_stage_valid" CHECK ("ingestion_jobs"."stage" is null or "ingestion_jobs"."stage" in ('extract', 'chunk', 'embed', 'store')),
	CONSTRAINT "ingestion_jobs_failed_has_error" CHECK ("ingestion_jobs"."status" <> 'FAILED' or ("ingestion_jobs"."error_code" is not null and "ingestion_jobs"."error_message" is not null)),
	CONSTRAINT "ingestion_jobs_completed_has_finish" CHECK ("ingestion_jobs"."status" <> 'COMPLETED' or "ingestion_jobs"."finished_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"publisher" text,
	"source_type" "source_type" NOT NULL,
	"original_url" text,
	"original_language" text,
	"publication_date" text,
	"edition" text,
	"license_kind" "license_kind" NOT NULL,
	"license_url" text,
	"license_notes" text,
	"allow_indexing" boolean DEFAULT false NOT NULL,
	"allow_quotation" boolean DEFAULT false NOT NULL,
	"allow_redistribution" boolean DEFAULT false NOT NULL,
	"content_checksum" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_identity_unique" UNIQUE NULLS NOT DISTINCT("title","author","publisher","edition"),
	CONSTRAINT "sources_title_not_blank" CHECK (length(btrim("sources"."title")) > 0),
	CONSTRAINT "sources_original_url_http" CHECK ("sources"."original_url" is null or "sources"."original_url" ~ '^https?://'),
	CONSTRAINT "sources_original_language_bcp47" CHECK ("sources"."original_language" is null or "sources"."original_language" ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
	CONSTRAINT "sources_publication_date_format" CHECK ("sources"."publication_date" is null or "sources"."publication_date" ~ '^[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?$'),
	CONSTRAINT "sources_content_checksum_sha256" CHECK ("sources"."content_checksum" is null or "sources"."content_checksum" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "sources_indexing_requires_legal_basis" CHECK ("sources"."allow_indexing" = false or "sources"."license_kind" not in ('unknown', 'proprietary')),
	CONSTRAINT "sources_licence_evidence_required" CHECK ("sources"."license_kind" not in ('licensed', 'permission_granted') or length(btrim(coalesce("sources"."license_notes", ''))) > 0),
	CONSTRAINT "sources_quotation_requires_indexing" CHECK ("sources"."allow_quotation" = false or "sources"."allow_indexing" = true),
	CONSTRAINT "sources_redistribution_requires_indexing" CHECK ("sources"."allow_redistribution" = false or "sources"."allow_indexing" = true)
);
--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_embeddings" ADD CONSTRAINT "chunk_embeddings_embedding_model_id_embedding_models_id_fk" FOREIGN KEY ("embedding_model_id") REFERENCES "public"."embedding_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_document_version_id_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_retry_of_job_id_ingestion_jobs_id_fk" FOREIGN KEY ("retry_of_job_id") REFERENCES "public"."ingestion_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_embedding_model_id_embedding_models_id_fk" FOREIGN KEY ("embedding_model_id") REFERENCES "public"."embedding_models"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_embeddings_model_idx" ON "chunk_embeddings" USING btree ("embedding_model_id");--> statement-breakpoint
CREATE INDEX "chunks_content_tsv_idx" ON "chunks" USING gin ("content_tsv");--> statement-breakpoint
CREATE INDEX "chunks_source_id_idx" ON "chunks" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "chunks_document_id_idx" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "documents_source_id_idx" ON "documents" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_version_idx" ON "ingestion_jobs" USING btree ("document_version_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_status_heartbeat_idx" ON "ingestion_jobs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingestion_jobs_one_active_per_version" ON "ingestion_jobs" USING btree ("document_version_id") WHERE "ingestion_jobs"."status" in ('PENDING', 'PROCESSING');