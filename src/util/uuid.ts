/**
 * Version-agnostic UUID shape guard. Postgres `::uuid` casts accept any
 * hex-formatted UUID regardless of version/variant, and throw `invalid input
 * syntax for type uuid` on anything else. Guarding agent/user-supplied ids with
 * this predicate BEFORE they reach a `::uuid` cast turns a 503 into a clean
 * "not found" (undefined), matching MemoryKnowledgeStore's permissive behavior.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isPersistedKnowledgeId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
