/**
 * Read an enum field from a persisted JSON payload.
 *
 * Older repository mappers accidentally treated the entire payload as a few
 * enum fields. Every aggregate save then wrapped the previous payload inside
 * that field again. Following the same field through nested objects recovers
 * the original scalar and lets the next save repair the stored payload.
 */
export function readNestedPayloadEnum<T extends string>(
  payload: unknown,
  field: string,
  allowedValues: readonly T[],
  fallback: T,
): T {
  let current = payload;
  const seen = new Set<object>();

  while (current && typeof current === "object" && !Array.isArray(current)) {
    if (seen.has(current)) return fallback;
    seen.add(current);

    const value = (current as Record<string, unknown>)[field];
    if (typeof value === "string") {
      return (allowedValues as readonly string[]).includes(value)
        ? value as T
        : fallback;
    }
    current = value;
  }

  return fallback;
}
