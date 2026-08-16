-- Per-minute rollup table for GET /logs/aggregate. Populated incrementally by the
-- ingest flush (see logRepository.ts) right after each COPY succeeds, so it's always
-- within one flush cycle (well under the 20s freshness requirement) of the raw table.
--
-- Not partitioned: at 1-minute granularity x however many distinct (service, level)
-- pairs actually appear, this stays orders of magnitude smaller than `logs` even over
-- the full 30-day retention window, so a plain table with its own PK index is enough.
CREATE TABLE log_rollups (
  bucket_start timestamptz NOT NULL,
  service      text NOT NULL,
  level        text NOT NULL,
  count        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_start, service, level)
);
--> statement-breakpoint

-- Supports the WHERE bucket_start >= $since AND bucket_start < $until range scan that
-- every aggregate query does; the PK already gives this for free via its leading column,
-- but an explicit index keeps the query plan stable regardless of how Postgres orders
-- the PK's underlying index.
CREATE INDEX idx_log_rollups_bucket_start ON log_rollups (bucket_start);
