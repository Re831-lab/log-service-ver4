// node-postgres (pg-pool) throws these exact message patterns when the connection pool
// cannot hand out a client -- either because our own pool's `max` is fully checked out
// (client-side connectionTimeoutMillis) or because Postgres itself is refusing new
// connections server-side. These are transient overload conditions, not application bugs,
// so they must be shed with 503 + Retry-After rather than surfaced as a raw 500.
const POOL_EXHAUSTION_PATTERNS = [
  /timeout exceeded when trying to connect/i,
  /too many clients already/i,
  /remaining connection slots are reserved/i,
  /connection terminated/i,
];

function matchesPoolExhaustionPattern(message: string): boolean {
  return POOL_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message));
}

// Drizzle wraps driver errors, and depending on the exact query shape sometimes leaves the
// underlying pg-pool message only on `.cause` (Node's standard error-chaining) rather than
// folding it into its own `.message`. Walk the cause chain, bounded to guard against a
// pathological cycle.
export function isPoolExhaustionError(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current != null; depth++) {
    const message = current instanceof Error ? current.message : String(current);
    if (matchesPoolExhaustionPattern(message)) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }

  return false;
}

// Escapes % and _ (LIKE/ILIKE wildcards) and the escape character itself so that
// substring search on arbitrary user input (the `q` param) is a literal substring match,
// not a wildcard pattern.
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
