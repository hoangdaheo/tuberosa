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

const RFC4122_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Strict RFC-4122 UUID check (version 1-5, standard variant). Stricter than
 * isPersistedKnowledgeId — use for validating user/agent-supplied identifier
 * *values*, not for guarding `::uuid` casts.
 */
export function isRfc4122Uuid(value: unknown): value is string {
  return typeof value === 'string' && RFC4122_PATTERN.test(value);
}
