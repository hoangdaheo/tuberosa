import type { KnowledgeItemType, KnowledgeNamespace } from '../types.js';

/**
 * Phase 6a — derive the namespace kind from a knowledge item's type.
 * Memory-shaped items (memory/bugfix/rule) collapse into a single `reflection`
 * namespace so durable lessons across types share a slot; everything else
 * keeps its itemType as kind so wiki/spec/code_ref/workflow/conversation
 * stay independently filterable.
 */
export function kindFromItemType(itemType: KnowledgeItemType): string {
  switch (itemType) {
    case 'memory':
    case 'bugfix':
    case 'rule':
      return 'reflection';
    case 'wiki':
      return 'wiki';
    case 'spec':
      return 'spec';
    case 'workflow':
      return 'workflow';
    case 'code_ref':
      return 'code_ref';
    case 'conversation':
      return 'conversation';
    default:
      return itemType;
  }
}

export function deriveNamespace(input: {
  project: string;
  itemType: KnowledgeItemType;
  metadata?: Record<string, unknown>;
  namespace?: KnowledgeNamespace;
}): KnowledgeNamespace {
  if (input.namespace?.project && input.namespace.kind) {
    return {
      project: input.namespace.project,
      kind: input.namespace.kind,
      agent: input.namespace.agent,
    };
  }
  const agent = pickAgentFromMetadata(input.metadata);
  return {
    project: input.project,
    kind: kindFromItemType(input.itemType),
    ...(agent ? { agent } : {}),
  };
}

/**
 * Phase 6a — agent-session reflections pass `metadata.agentName` (and historically
 * `agentTool`) through the learning gate. When present, prefer that as the
 * namespace agent so filtering by agent surfaces the right slot.
 */
function pickAgentFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const candidate = metadata.agentName ?? metadata.agentTool;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined;
}

/**
 * Phase 6a — extract a namespace from a metadata blob. Backwards-compatible:
 * returns `undefined` when no namespace was persisted (the caller should fall
 * back to {@link deriveNamespace}).
 */
export function readNamespaceFromMetadata(
  metadata: Record<string, unknown> | undefined,
): KnowledgeNamespace | undefined {
  if (!metadata) return undefined;
  const raw = metadata.namespace;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const project = typeof record.project === 'string' ? record.project : undefined;
  const kind = typeof record.kind === 'string' ? record.kind : undefined;
  if (!project || !kind) return undefined;
  const agent = typeof record.agent === 'string' && record.agent.trim().length > 0
    ? record.agent.trim()
    : undefined;
  return agent ? { project, kind, agent } : { project, kind };
}

/**
 * Phase 6a — merge a derived namespace into the metadata blob persisted with
 * the knowledge item. Returns a new record; the input is not mutated.
 */
export function writeNamespaceToMetadata(
  metadata: Record<string, unknown> | undefined,
  namespace: KnowledgeNamespace,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    namespace: {
      project: namespace.project,
      kind: namespace.kind,
      ...(namespace.agent ? { agent: namespace.agent } : {}),
    },
  };
}

/**
 * Phase 6a — return `true` when the candidate's stored namespace passes the
 * supplied filter. An undefined filter (or undefined candidate namespace) is
 * a no-op — backwards compatibility is the load-bearing default.
 */
export function namespaceMatchesFilter(
  stored: KnowledgeNamespace | undefined,
  filter: Partial<KnowledgeNamespace> | undefined,
): boolean {
  if (!filter || (!filter.kind && !filter.agent && !filter.project)) return true;
  if (!stored) return false;
  if (filter.kind && filter.kind !== stored.kind) return false;
  if (filter.agent && filter.agent !== stored.agent) return false;
  if (filter.project && filter.project !== stored.project) return false;
  return true;
}
