export interface GraphItem {
  id: string;
  title: string;
  itemType: string;
  score: number;
  labels?: string[];
}

export interface GraphRelation {
  sourceId: string;
  targetId: string;
  kind: string;
}

export interface GraphInput {
  items: GraphItem[];
  relations: GraphRelation[];
}

export interface CyElement {
  data: Record<string, unknown>;
}

export function toGraphElements(input: GraphInput): CyElement[] {
  const nodes: CyElement[] = input.items.map((i) => ({
    data: {
      id: i.id,
      label: i.title,
      itemType: i.itemType,
      score: i.score,
      labels: (i.labels ?? []).join(','),
    },
  }));
  const edges: CyElement[] = input.relations.map((r) => ({
    data: {
      id: `${r.sourceId}->${r.targetId}:${r.kind}`,
      source: r.sourceId,
      target: r.targetId,
      kind: r.kind,
    },
  }));
  return [...nodes, ...edges];
}
