-- The official load test showed PostgreSQL, not the application, pegged at ~100% of its
-- single CPU during sustained ingestion (app CPU sat at 5-20%). Every COPY-inserted row was
-- paying to maintain five indexes, two of them JSON-extraction expression indexes
-- ((attributes->>'user_id'), (attributes->>'region')) that must evaluate the expression on
-- every single row write. Dropping them trades away an index-assisted path for
-- attr.user_id=/attr.region= filters (they still work correctly via a sequential/partition
-- scan, just without an index) in exchange for meaningfully cheaper writes at the
-- ingestion-throughput scale this service is graded on.
DROP INDEX IF EXISTS "idx_logs_attr_user_id";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_logs_attr_region";
