import { Router, type Request, type Response } from "express";
import { validateLogEntry, type ValidatedLogEntry } from "../validation/logValidation.js";
import { validateQueryParams, encodeCursor } from "../validation/queryValidation.js";
import { insertLogs, queryLogs, QueueFullError } from "../repositories/logRepository.js";
import { validateAggregateParams } from "../validation/queryValidation.js";
import { queryAggregate } from "../repositories/logRepository.js";
import { isPoolExhaustionError } from "../utils/poolErrors.js";

function respondToIngestDbError(res: Response, err: unknown, context: string): Response {
  if (isPoolExhaustionError(err)) {
    console.warn(`${context}: database pool exhausted, shedding load with 503`);
    return res
      .status(503)
      .set("Retry-After", "1")
      .json({ error: "service temporarily overloaded, retry shortly" });
  }
  console.error(`${context}:`, err);
  return res.status(500).json({ error: "internal server error" });
}


function respondToQueryDbError(res: Response, err: unknown, context: string): Response {
  console.error(`${context}:`, err);
  return res.status(500).json({ error: "internal server error" });
}

export const logsRouter = Router();

interface RejectedEntry {
  index: number;
  reason: string;
}

logsRouter.post("/logs", async (req: Request, res: Response) => {
  const body = req.body;

  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray(body.logs)
  ) {
    return res.status(400).json({
      error: "request body must be an object with a 'logs' array",
    });
  }

  const rawLogs: unknown[] = body.logs;
  const validEntries: ValidatedLogEntry[] = [];
  const rejected: RejectedEntry[] = [];
  const now = Date.now();

  rawLogs.forEach((rawLog, index) => {
    const result = validateLogEntry(rawLog, now);
    if (result.valid && result.entry) {
      validEntries.push(result.entry);
    } else {
      rejected.push({ index, reason: result.reason ?? "invalid log entry" });
    }
  });

  if (validEntries.length === 0) {
    return res.status(400).json({
      accepted: 0,
      rejected,
    });
  }

  try {
    await insertLogs(validEntries);
  } catch (err) {
    if (err instanceof QueueFullError) {
      return res
        .status(503)
        .set("Retry-After", "1")
        .json({ error: err.message });
    }
    return respondToIngestDbError(res, err, "POST /logs");
  }

  return res.status(200).json({
    accepted: validEntries.length,
    rejected,
  });
});

logsRouter.get("/logs", async (req: Request, res: Response) => {
  const validation = validateQueryParams(req.query as Record<string, unknown>);

  if (!validation.valid || !validation.params) {
    return res.status(400).json({ error: validation.error });
  }

  const params = validation.params;

  let rows;
  try {
    rows = await queryLogs(params);
  } catch (err) {
    return respondToQueryDbError(res, err, "GET /logs");
  }

  const hasMore = rows.length > params.limit;
  const pageRows = hasMore ? rows.slice(0, params.limit) : rows;

  const nextCursor = hasMore
    ? encodeCursor(
        pageRows[pageRows.length - 1].timestamp,
        pageRows[pageRows.length - 1].id
      )
    : null;

  return res.status(200).json({
    logs: pageRows.map((row) => ({
      id: String(row.id),
      timestamp: row.timestamp.toISOString(),
      level: row.level,
      service: row.service,
      message: row.message,
      attributes: row.attributes,
    })),
    next_cursor: nextCursor,
  });
});

logsRouter.get("/logs/aggregate", async (req: Request, res: Response) => {
  const validation = validateAggregateParams(req.query as Record<string, unknown>);

  if (!validation.valid || !validation.params) {
    return res.status(400).json({ error: validation.error });
  }

  let rows;
  try {
    rows = await queryAggregate(validation.params);
  } catch (err) {
    return respondToQueryDbError(res, err, "GET /logs/aggregate");
  }

  return res.status(200).json({
    buckets: rows.map((row) => ({
      start: row.bucketStart.toISOString(),
      group: row.group,
      count: row.count,
    })),
  });
});
