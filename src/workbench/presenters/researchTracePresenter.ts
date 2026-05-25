import type { ResearchTraceStep, ResearchTraceSummary } from '../types.js';

const STEP_KINDS = new Set<ResearchTraceStep['kind']>(['thought', 'action', 'observation', 'decision']);

export function extractResearchTrace(metadata: Record<string, unknown> | undefined | null): ResearchTraceSummary | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const raw = (metadata as Record<string, unknown>).researchTrace;
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ResearchTraceSummary>;
  const rawSteps = Array.isArray(candidate.steps) ? candidate.steps : [];
  const steps: ResearchTraceStep[] = [];
  for (const step of rawSteps) {
    if (!step || typeof step !== 'object') continue;
    const s = step as { kind?: unknown; text?: unknown; references?: unknown };
    if (typeof s.kind !== 'string' || !STEP_KINDS.has(s.kind as ResearchTraceStep['kind'])) continue;
    if (typeof s.text !== 'string') continue;
    steps.push({
      kind: s.kind as ResearchTraceStep['kind'],
      text: s.text,
      references: Array.isArray(s.references) ? (s.references as ResearchTraceStep['references']) : undefined,
    });
  }
  if (steps.length === 0) return undefined;
  return {
    steps,
    outcome: typeof candidate.outcome === 'string' ? candidate.outcome : '',
    derived: Boolean(candidate.derived),
    bytes: typeof candidate.bytes === 'number' ? candidate.bytes : 0,
  };
}
