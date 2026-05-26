export type StageState = 'pending' | 'active' | 'done' | 'skipped' | 'failed';

export interface Step {
  id: string;
  title: string;
  blurb: string;
  state: StageState;
  ms?: number;
}

const STAGES: Array<Pick<Step, 'id' | 'title' | 'blurb'>> = [
  { id: 'receive', title: '1 · Receive', blurb: 'Agent calls tuberosa_search_context.' },
  { id: 'classify', title: '2 · Classify', blurb: 'Pull project, task, files, symbols, errors out of the prompt.' },
  { id: 'rewrite', title: '3 · Rewrite', blurb: 'If the probe is weak, ask the model for a better query.' },
  { id: 'search', title: '4 · Search', blurb: 'Labels, FTS, vector, memory — all in parallel. Then graph.' },
  { id: 'fuse', title: '5 · Fuse', blurb: 'Weighted reciprocal-rank fusion into one ranked list.' },
  { id: 'rerank', title: '6 · Rerank', blurb: 'Re-order the top slice with a reranker.' },
  { id: 'adjust', title: '7 · Adjust', blurb: 'Boost feedback winners, penalize stale or superseded.' },
  { id: 'fit', title: '8 · Fit', blurb: 'Decide: ready, needs_confirmation, insufficient.' },
  { id: 'assemble', title: '9 · Assemble', blurb: 'Split into essential / supporting / optional within budget.' },
  { id: 'deep', title: '10 · Deep', blurb: 'Expand chosen items into full chunks (layered mode).' },
];

export function pipelineSteps(timings: Partial<Record<string, number>> = {}): Step[] {
  return STAGES.map((s) => {
    const ms = timings[s.id];
    let state: StageState = 'pending';
    if (ms === undefined) state = 'pending';
    else if (ms === 0) state = 'skipped';
    else state = 'done';
    return { ...s, state, ms };
  });
}
