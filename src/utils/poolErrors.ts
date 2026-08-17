
const POOL_EXHAUSTION_PATTERNS = [
  /timeout exceeded when trying to connect/i,
  /too many clients already/i,
  /remaining connection slots are reserved/i,
  /connection terminated/i,
];

function matchesPoolExhaustionPattern(message: string): boolean {
  return POOL_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message));
}


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


export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
