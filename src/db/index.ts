import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import { env } from "../config/env.js";
import "dotenv/config";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not defined");
}

// Ingestion pool: POST /logs holds one connection per flushed micro-batch while streaming
// COPY. Sized and timed out generously so a burst of ingestion traffic waits rather than
// gets dropped.
export const ingestPool = new Pool({
  connectionString,
  max: env.dbIngestPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: env.dbPoolConnectTimeoutMs,
});

// Query pool: GET /logs, GET /logs/aggregate, and retention. Short statements that must
// stay responsive even while ingestion is saturating the ingest pool, so it has its own
// (shorter) connect timeout -- fail fast instead of inflating query latency.
export const queryPool = new Pool({
  connectionString,
  max: env.dbQueryPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: env.dbQueryPoolConnectTimeoutMs,
});

// Tiny dedicated pool for GET /health only, so a liveness probe never queues behind
// application query/ingestion load and reports a genuinely unreachable database quickly.
// 5s (not 2s) so a database that's merely busy under heavy load isn't misreported as
// unreachable -- distinguishing "slow" from "down" matters since a flapping health check can
// have knock-on effects on how a test harness or orchestrator treats the container.
export const healthPool = new Pool({
  connectionString,
  max: 2,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(queryPool, { schema });
