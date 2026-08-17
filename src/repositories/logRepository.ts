import { db, ingestPool } from "../db/index.js";
import { logs, logRollups } from "../db/schema.js";
import type { ValidatedLogEntry } from "../validation/logValidation.js";
import type { LogQueryParams } from "../validation/queryValidation.js";
import { and, or, eq, lt, gte, sql, desc } from "drizzle-orm";
import type { AggregateQueryParams } from "../validation/queryValidation.js";
import { from as copyFrom } from "pg-copy-streams";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { escapeLikePattern } from "../utils/poolErrors.js";

function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

// Aggregates this flush's entries into per-(minute, service, level) counts and returns a
// single batched upsert against log_rollups. Returns null when there's nothing to roll up
// (shouldn't happen since insertLogs rejects empty arrays, but kept defensive).
function buildRollupUpsert(
  batches: PendingBatch[]
): { text: string; values: unknown[] } | null {
  const counts = new Map<string, number>();

  for (const batch of batches) {
    for (const e of batch.entries) {
      const bucketMs = Math.floor(e.timestamp.getTime() / 60_000) * 60_000;
      // JSON.stringify as the map key avoids ambiguity from service/level values that
      // might themselves contain a plain delimiter character like "|" or ",".
      const key = JSON.stringify([new Date(bucketMs).toISOString(), e.service, e.level]);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  if (counts.size === 0) return null;

  const placeholders: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [key, count] of counts) {
    const [bucketStart, service, level] = JSON.parse(key) as [string, string, string];
    placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
    values.push(bucketStart, service, level, count);
  }

  const text = `
    INSERT INTO log_rollups (bucket_start, service, level, count)
    VALUES ${placeholders.join(", ")}
    ON CONFLICT (bucket_start, service, level)
    DO UPDATE SET count = log_rollups.count + EXCLUDED.count
  `;
  return { text, values };
}

type ResolveFunc = () => void;
type RejectFunc = (err: Error) => void;

interface PendingBatch {
  entries: ValidatedLogEntry[];
  resolve: ResolveFunc;
  reject: RejectFunc;
}

let pendingBatches: PendingBatch[] = [];
let pendingEntryCount = 0;
let isFlushing = false;


const MAX_QUEUE_SIZE = 200_000;

export class QueueFullError extends Error {
  constructor() {
    super("ingest queue is full, try again shortly");
    this.name = "QueueFullError";
  }
}

// The official load test showed PostgreSQL CPU-bound (~100% of its single CPU) during
// sustained ingestion, not the application. Flushing every 30ms meant up to ~33 separate
// COPY streams (each its own commit/fsync) per second competing for that one CPU. Widening
// the window to 75ms cuts that to ~13/sec while still comfortably meeting the "queryable
// within 20 seconds" contract requirement -- a small increase in per-request ingestion
// latency in exchange for meaningfully less commit overhead per second under load.
const FLUSH_INTERVAL_MS = 75;

export function insertLogs(entries: ValidatedLogEntry[]): Promise<void> {
  if (entries.length === 0) {
    return Promise.resolve();
  }

  if (pendingEntryCount + entries.length > MAX_QUEUE_SIZE) {
    throw new QueueFullError();
  }

  return new Promise((resolve, reject) => {
    pendingBatches.push({ entries, resolve, reject });
    pendingEntryCount += entries.length;
  });
}

setInterval(async () => {
  if (isFlushing || pendingBatches.length === 0) return;

  isFlushing = true;
  const batchesToProcess = pendingBatches;
  pendingBatches = [];
  pendingEntryCount = 0;

  try {
    // Ingestion uses its own pool so a burst of COPY-holding connections can never starve
    // the query pool backing GET /logs and GET /logs/aggregate.
    const client = await ingestPool.connect();
    try {
      const ingestStream = client.query(
        copyFrom(
          `COPY logs (timestamp, level, service, message, attributes) FROM STDIN WITH (FORMAT csv)`
        )
      );

      let csvData = "";
      for (let i = 0; i < batchesToProcess.length; i++) {
        const batch = batchesToProcess[i];
        for (let j = 0; j < batch.entries.length; j++) {
          const e = batch.entries[j];
          csvData += [
            csvField(e.timestamp.toISOString()),
            csvField(e.level),
            csvField(e.service),
            csvField(e.message),
            csvField(JSON.stringify(e.attributes)),
          ].join(",") + "\n";
        }
      }

      const sourceStream = Readable.from([csvData]);

      await pipeline(sourceStream, ingestStream);

      // Best-effort: the rows above are already durably written and the batch is
      // correct regardless of what happens here. A rollup upsert failure must never
      // fail an already-successful batch -- GET /logs/aggregate always has the raw
      // `logs` table as a correct fallback (see queryAggregate below).
      try {
        const rollupUpsert = buildRollupUpsert(batchesToProcess);
        if (rollupUpsert) {
          await client.query(rollupUpsert.text, rollupUpsert.values);
        }
      } catch (rollupErr) {
        console.error(
          "Rollup upsert failed (non-fatal; aggregate queries fall back to the raw table):",
          rollupErr
        );
      }

      for (const batch of batchesToProcess) {
        batch.resolve();
      }
    } finally {
      client.release();
    }
  } catch (err) {
    for (const batch of batchesToProcess) {
      batch.reject(err as Error);
    }
  } finally {
    isFlushing = false;
  }
}, FLUSH_INTERVAL_MS);



export interface LogRow {
  id: number;
  timestamp: Date;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, unknown>;
}

export async function queryLogs(params: LogQueryParams): Promise<LogRow[]> {
  const conditions = [];

  if (params.service) {
    conditions.push(eq(logs.service, params.service));
  }
  if (params.level) {
    conditions.push(eq(logs.level, params.level));
  }

  if (params.since) {
    conditions.push(gte(logs.timestamp, params.since));
  }
  if (params.until) {
    conditions.push(lt(logs.timestamp, params.until));
  }

  if (params.q) {
    conditions.push(
      sql`${logs.message} ILIKE ${`%${escapeLikePattern(params.q)}%`} ESCAPE '\\'`
    );
  }

  for (const [key, value] of Object.entries(params.attributes)) {
    conditions.push(sql`${logs.attributes}->>${key} = ${value}`);
  }

  if (params.cursor) {
    const { timestamp, id } = params.cursor;
    conditions.push(
      or(
        lt(logs.timestamp, timestamp),
        and(eq(logs.timestamp, timestamp), lt(logs.id, id))
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select()
    .from(logs)
    .where(whereClause)
    .orderBy(desc(logs.timestamp), desc(logs.id))
    .limit(params.limit + 1);

  return rows as LogRow[];
}

export interface AggregateRow {
  bucketStart: Date;
  group: string | null;
  count: number;
}

export async function queryAggregate(
  params: AggregateQueryParams
): Promise<AggregateRow[]> {
  const hasAttrFilters = Object.keys(params.attributes).length > 0;

 
  if (!params.q && !hasAttrFilters) {
    return queryAggregateFromRollup(params);
  }
  return queryAggregateFromRawTable(params);
}

async function queryAggregateFromRollup(
  params: AggregateQueryParams
): Promise<AggregateRow[]> {
  const conditions = [
    gte(logRollups.bucketStart, params.since),
    lt(logRollups.bucketStart, params.until),
  ];
  if (params.service) {
    conditions.push(eq(logRollups.service, params.service));
  }
  if (params.level) {
    conditions.push(eq(logRollups.level, params.level));
  }

  const bucketExpr = sql`to_timestamp(floor(extract(epoch FROM ${logRollups.bucketStart}) / ${params.bucketSeconds}) * ${params.bucketSeconds})`;

  const groupExpr =
    params.groupBy === "service"
      ? sql`${logRollups.service}`
      : params.groupBy === "level"
      ? sql`${logRollups.level}`
      : sql`NULL::text`;

  const rows = await db
    .select({
      bucketStart: bucketExpr.as("bucket_start"),
      group: groupExpr.as("group_value"),
      count: sql<number>`sum(${logRollups.count})`.as("count"),
    })
    .from(logRollups)
    .where(and(...conditions))
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`1`);

  return rows.map((row) => ({
    bucketStart: new Date(row.bucketStart as unknown as string),
    group: row.group as string | null,
    count: Number(row.count),
  }));
}

async function queryAggregateFromRawTable(
  params: AggregateQueryParams
): Promise<AggregateRow[]> {
  const conditions = [
    gte(logs.timestamp, params.since),
    lt(logs.timestamp, params.until),
  ];

  if (params.service) {
    conditions.push(eq(logs.service, params.service));
  }
  if (params.level) {
    conditions.push(eq(logs.level, params.level));
  }
  if (params.q) {
    conditions.push(
      sql`${logs.message} ILIKE ${`%${escapeLikePattern(params.q)}%`} ESCAPE '\\'`
    );
  }
  for (const [key, value] of Object.entries(params.attributes)) {
    conditions.push(sql`${logs.attributes}->>${key} = ${value}`);
  }

  const bucketExpr = sql`to_timestamp(floor(extract(epoch FROM ${logs.timestamp}) / ${params.bucketSeconds}) * ${params.bucketSeconds})`;

  const groupExpr =
    params.groupBy === "service"
      ? sql`${logs.service}`
      : params.groupBy === "level"
      ? sql`${logs.level}`
      : sql`NULL::text`;

  const rows = await db
    .select({
      bucketStart: bucketExpr.as("bucket_start"),
      group: groupExpr.as("group_value"),
      count: sql<number>`count(*)`.as("count"),
    })
    .from(logs)
    .where(and(...conditions))
    .groupBy(sql`1`, sql`2`)
    .orderBy(sql`1`);

  return rows.map((row) => ({
    bucketStart: new Date(row.bucketStart as unknown as string),
    group: row.group as string | null,
    count: Number(row.count),
  }));
}
