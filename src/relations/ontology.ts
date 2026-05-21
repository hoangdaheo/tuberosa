import type { LabelInput, LabelType } from '../types.js';
import { normalizeLabel } from '../util/text.js';

export type OntologyAxis = 'technology' | 'business_area' | 'domain';

export interface OntologyNode {
  value: string;
  children?: OntologyNode[];
}

export interface OntologyExpansion {
  /** The original leaf label, normalized. */
  leaf: string;
  /** Ancestors from immediate parent up to root. Empty when the label is a root or unknown. */
  ancestors: string[];
  /** True when the value was recognized inside the ontology. */
  matched: boolean;
}

const TECHNOLOGY_ONTOLOGY: OntologyNode[] = [
  {
    value: 'frontend',
    children: [
      { value: 'react', children: [{ value: 'next' }] },
      { value: 'typescript' },
      { value: 'javascript' },
    ],
  },
  {
    value: 'backend',
    children: [
      { value: 'node' },
      { value: 'typescript' },
      { value: 'python' },
      { value: 'go' },
      { value: 'rust' },
    ],
  },
  {
    value: 'db',
    children: [
      { value: 'postgres', children: [{ value: 'pgvector' }] },
      { value: 'redis' },
    ],
  },
  {
    value: 'infra',
    children: [
      { value: 'docker' },
      { value: 'aws', children: [{ value: 'lambda' }, { value: 'serverless' }] },
    ],
  },
  {
    value: 'protocol',
    children: [
      { value: 'mcp' },
      { value: 'graphql' },
      { value: 'rest' },
    ],
  },
];

const BUSINESS_AREA_ONTOLOGY: OntologyNode[] = [
  {
    value: 'auth',
    children: [
      { value: 'login' },
      { value: 'token' },
      { value: 'session' },
    ],
  },
  {
    value: 'billing',
    children: [
      { value: 'subscription' },
      { value: 'paywall' },
      { value: 'invoice' },
    ],
  },
  {
    value: 'search',
    children: [
      { value: 'retrieval' },
      { value: 'ranking' },
    ],
  },
  {
    value: 'content',
    children: [
      { value: 'newsletter' },
      { value: 'publishing' },
      { value: 'media' },
    ],
  },
  {
    value: 'engagement',
    children: [
      { value: 'analytics' },
      { value: 'notification' },
      { value: 'profile' },
    ],
  },
  {
    value: 'ads',
  },
];

const DOMAIN_ONTOLOGY: OntologyNode[] = [
  {
    value: 'infra',
    children: [
      { value: 'docker' },
      { value: 'ci' },
      { value: 'build' },
    ],
  },
  {
    value: 'storage',
    children: [
      { value: 'postgres' },
      { value: 'redis' },
    ],
  },
  {
    value: 'observability',
    children: [
      { value: 'logging' },
      { value: 'metrics' },
      { value: 'tracing' },
    ],
  },
];

const ONTOLOGY_BY_AXIS: Record<OntologyAxis, OntologyNode[]> = {
  technology: TECHNOLOGY_ONTOLOGY,
  business_area: BUSINESS_AREA_ONTOLOGY,
  domain: DOMAIN_ONTOLOGY,
};

type AncestorIndex = Map<string, string[]>;

const ANCESTOR_INDICES: Partial<Record<OntologyAxis, AncestorIndex>> = {};

function indexForAxis(axis: OntologyAxis): AncestorIndex {
  const cached = ANCESTOR_INDICES[axis];
  if (cached) return cached;
  const index: AncestorIndex = new Map();
  for (const root of ONTOLOGY_BY_AXIS[axis]) {
    walkOntology(root, [], index);
  }
  ANCESTOR_INDICES[axis] = index;
  return index;
}

function walkOntology(node: OntologyNode, parentChain: string[], index: AncestorIndex): void {
  const key = normalizeLabel(node.value);
  const existing = index.get(key);
  if (!existing) {
    index.set(key, [...parentChain]);
  }
  for (const child of node.children ?? []) {
    walkOntology(child, [...parentChain, node.value], index);
  }
}

export function ontologyAxisFromLabelType(type: LabelType): OntologyAxis | undefined {
  if (type === 'technology' || type === 'business_area' || type === 'domain') {
    return type;
  }
  return undefined;
}

export function expandOntologyValue(axis: OntologyAxis, value: string): OntologyExpansion {
  const leaf = normalizeLabel(value);
  const index = indexForAxis(axis);
  const ancestors = index.get(leaf);
  if (!ancestors) {
    return { leaf, ancestors: [], matched: false };
  }
  // Index stores parent chain from root → leaf. We return ancestors ordered closest-first
  // so callers can attenuate by distance with index-as-distance semantics.
  return {
    leaf,
    ancestors: [...ancestors].reverse().map((ancestor) => normalizeLabel(ancestor)),
    matched: true,
  };
}

export interface ExpandLabelsOptions {
  enabled?: boolean;
}

/**
 * Expand each ontology-aware label (technology / business_area / domain) to include its
 * normalized ancestors. Ancestors are added with reduced weight + `provenance.source='ontology'`
 * so the original leaf label still dominates ranking. Non-ontology labels pass through unchanged.
 */
export function expandLabelsThroughOntology(
  labels: LabelInput[],
  options: ExpandLabelsOptions = {},
): LabelInput[] {
  if (options.enabled === false) {
    return labels;
  }

  const seen = new Set<string>();
  const result: LabelInput[] = [];

  for (const label of labels) {
    const key = `${label.type}:${normalizeLabel(label.value)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(label);
    }

    const axis = ontologyAxisFromLabelType(label.type);
    if (!axis) continue;

    const expansion = expandOntologyValue(axis, label.value);
    if (!expansion.matched) continue;

    for (let i = 0; i < expansion.ancestors.length; i += 1) {
      const ancestor = expansion.ancestors[i];
      const ancestorKey = `${label.type}:${ancestor}`;
      if (seen.has(ancestorKey)) continue;
      seen.add(ancestorKey);
      // Closer ancestors keep more weight than far ones; never above the leaf.
      const ancestorWeight = Math.max(0.3, (label.weight ?? 0.75) * (0.7 - i * 0.1));
      result.push({
        type: label.type,
        value: ancestor,
        weight: Math.min(label.weight ?? 0.75, ancestorWeight),
        provenance: { source: 'ontology', confidence: Math.max(0.4, 0.85 - i * 0.1) },
      });
    }
  }

  return result;
}

/** True when `candidateValue` is an ancestor of `leafValue` under `axis`, or equal to it. */
export function isOntologyMatch(axis: OntologyAxis, leafValue: string, candidateValue: string): boolean {
  const target = normalizeLabel(candidateValue);
  const leaf = normalizeLabel(leafValue);
  if (target === leaf) return true;
  const expansion = expandOntologyValue(axis, leafValue);
  return expansion.matched && expansion.ancestors.includes(target);
}
