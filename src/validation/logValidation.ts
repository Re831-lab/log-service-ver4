export type LogLevel = "debug" | "info" | "warn" | "error";

const VALID_LEVELS = new Set<string>(["debug", "info", "warn", "error"]);
const MAX_FUTURE_MS = 5 * 60 * 1000;

export interface RawLogEntry {
  timestamp?: unknown;
  level?: unknown;
  service?: unknown;
  message?: unknown;
  attributes?: unknown;
}

export interface ValidatedLogEntry {
  timestamp: Date;
  level: LogLevel;
  service: string;
  message: string;
  attributes: Record<string, string | number | boolean>;
}

export interface ValidationResult {
  valid: boolean;
  entry?: ValidatedLogEntry;
  reason?: string;
}

// PostgreSQL's text/CSV COPY protocol cannot represent a NUL byte in a data value. Ingestion
// flushes many HTTP requests' entries into one shared COPY stream (see logRepository.ts), so
// a single NUL byte would otherwise fail everyone's batch, not just the offending entry --
// reject it here instead, per-entry, before it ever reaches the shared stream.
function containsNul(value: string): boolean {
  return value.includes("\u0000");
}

export function validateLogEntry(raw: unknown, now: number): ValidationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, reason: "log entry must be an object" };
  }

  const entry = raw as RawLogEntry;

  if (entry.timestamp === undefined || entry.timestamp === null) {
    return { valid: false, reason: "timestamp is required" };
  }
  if (typeof entry.timestamp !== "string") {
    return { valid: false, reason: "timestamp must be a string" };
  }
  const parsedDate = new Date(entry.timestamp);
  const parsedTime = parsedDate.getTime();
  if (isNaN(parsedTime)) {
    return { valid: false, reason: `invalid timestamp: '${entry.timestamp}'` };
  }
  if (parsedTime - now > MAX_FUTURE_MS) {
    return { valid: false, reason: "timestamp is more than five minutes in the future" };
  }

  if (entry.level === undefined || entry.level === null) {
    return { valid: false, reason: "level is required" };
  }
  if (typeof entry.level !== "string" || !VALID_LEVELS.has(entry.level)) {
    return { valid: false, reason: `invalid level: '${entry.level}'` };
  }

  if (entry.service === undefined || entry.service === null) {
    return { valid: false, reason: "service is required" };
  }
  if (typeof entry.service !== "string" || entry.service.trim() === "") {
    return { valid: false, reason: "service must be a non-empty string" };
  }
  if (containsNul(entry.service)) {
    return { valid: false, reason: "service must not contain a NUL character" };
  }

  if (entry.message === undefined || entry.message === null) {
    return { valid: false, reason: "message is required" };
  }
  if (typeof entry.message !== "string" || entry.message.trim() === "") {
    return { valid: false, reason: "message must be a non-empty string" };
  }
  if (containsNul(entry.message)) {
    return { valid: false, reason: "message must not contain a NUL character" };
  }

  let attributes: Record<string, string | number | boolean> = {};
  if (entry.attributes !== undefined && entry.attributes !== null) {
    if (typeof entry.attributes !== "object" || Array.isArray(entry.attributes)) {
      return { valid: false, reason: "attributes must be a flat object" };
    }

    const rawAttrs = entry.attributes as Record<string, unknown>;
    for (const key in rawAttrs) {
      if (!Object.prototype.hasOwnProperty.call(rawAttrs, key)) continue;
      const value = rawAttrs[key];
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        return {
          valid: false,
          reason: `attribute '${key}' must be a string, number, or boolean`,
        };
      }
      if (containsNul(key) || (typeof value === "string" && containsNul(value))) {
        return {
          valid: false,
          reason: `attribute '${key}' must not contain a NUL character`,
        };
      }
    }
    attributes = rawAttrs as Record<string, string | number | boolean>;
  }

  return {
    valid: true,
    entry: {
      timestamp: parsedDate,
      level: entry.level as LogLevel,
      service: entry.service,
      message: entry.message,
      attributes,
    },
  };
}