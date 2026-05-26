import { useEffect, useRef, useState } from 'preact/hooks';
import { observeChapter } from '../state/scrollController.js';
import { PipelineFlow } from '../viz/PipelineFlow.js';
import { pipelineSteps } from '../viz/pipeline-flow-vm.js';
import { GraphCanvas } from '../viz/GraphCanvas.js';
import { acmeBilling } from '../data/fixtures.js';
import type { GraphInput } from '../viz/graph-data.js';

const TIMINGS = {
  receive: 1,
  classify: 12,
  rewrite: 0,
  search: 38,
  fuse: 5,
  rerank: 22,
  adjust: 3,
  fit: 1,
  assemble: 2,
  deep: 0,
};

function fromItems(ids: string[], score = 0.5): GraphInput['items'] {
  return ids
    .map((id) => {
      const it = acmeBilling.items.find((i) => i.id === id);
      return it
        ? { id: it.id, title: it.title, itemType: it.itemType as string, score }
        : null;
    })
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
}

function graphForStep(stepId: string): GraphInput {
  switch (stepId) {
    case 'classify':
      return {
        items: [
          { id: 'symbol:paywall', title: 'paywall', itemType: 'wiki', score: 1 },
          { id: 'symbol:logic', title: 'logic', itemType: 'wiki', score: 1 },
          { id: 'area:subscription', title: 'subscription', itemType: 'wiki', score: 1 },
        ],
        relations: [],
      };
    case 'search':
      return {
        items: fromItems(['cr-paywall-001', 'spec-subscription-tiers', 'cr-auth-middleware-001', 'mem-embed-dim-fix']),
        relations: [],
      };
    case 'fuse': {
      const items = fromItems(
        ['cr-paywall-001', 'spec-subscription-tiers', 'cr-paywall-002', 'spec-webhook-billing'],
        0.9,
      );
      const relations = items.slice(0, -1).map((it, i) => ({
        sourceId: it.id,
        targetId: items[i + 1].id,
        kind: 'rank',
      }));
      return { items, relations };
    }
    case 'rerank': {
      const items = fromItems(
        ['spec-subscription-tiers', 'cr-paywall-001', 'cr-paywall-002', 'spec-webhook-billing'],
      );
      return {
        items,
        relations: items.slice(0, -1).map((it, i) => ({
          sourceId: it.id,
          targetId: items[i + 1].id,
          kind: 'rerank',
        })),
      };
    }
    case 'adjust':
      return {
        items: fromItems(['cr-paywall-001', 'spec-subscription-tiers', 'mem-liveintent-old']),
        relations: [],
      };
    case 'fit':
      return {
        items: [{ id: 'fit:ready', title: 'ready', itemType: 'wiki', score: 1 }],
        relations: [],
      };
    case 'assemble':
      return {
        items: [
          { id: 'sect:essential', title: 'essential', itemType: 'wiki', score: 1 },
          { id: 'sect:supporting', title: 'supporting', itemType: 'wiki', score: 1 },
          { id: 'sect:optional', title: 'optional', itemType: 'wiki', score: 1 },
          ...fromItems(['cr-paywall-001', 'spec-subscription-tiers']),
        ],
        relations: [
          { sourceId: 'sect:essential', targetId: 'cr-paywall-001', kind: 'contains' },
          { sourceId: 'sect:supporting', targetId: 'spec-subscription-tiers', kind: 'contains' },
        ],
      };
    case 'deep':
      return {
        items: [
          ...fromItems(['cr-paywall-001']),
          { id: 'chunk:paywall-1', title: 'chunk #1', itemType: 'wiki', score: 1 },
          { id: 'chunk:paywall-2', title: 'chunk #2', itemType: 'wiki', score: 1 },
        ],
        relations: [
          { sourceId: 'cr-paywall-001', targetId: 'chunk:paywall-1', kind: 'expands' },
          { sourceId: 'cr-paywall-001', targetId: 'chunk:paywall-2', kind: 'expands' },
        ],
      };
    default:
      return { items: [], relations: [] };
  }
}

export default function Ch04_Pipeline() {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => (ref.current ? observeChapter(ref.current, 4) : undefined), []);
  const [sel, setSel] = useState<string>('search');
  const steps = pipelineSteps(TIMINGS);
  return (
    <section id="ch4" class="chapter" ref={ref}>
      <h2>The pipeline, stage by stage</h2>
      <p class="lead">Click any stage to see exactly what it produced for our prompt.</p>
      <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:16px;margin-top:16px">
        <PipelineFlow steps={steps} selected={sel} onSelect={setSel} />
        <div>
          <h3 style="margin:0 0 8px">
            What "{steps.find((s) => s.id === sel)?.title}" produced
          </h3>
          <GraphCanvas
            input={graphForStep(sel)}
            layout={sel === 'fuse' || sel === 'rerank' ? 'dagre' : 'cose'}
          />
        </div>
      </div>
    </section>
  );
}
