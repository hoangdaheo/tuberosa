import { GlossaryTerm } from '../components/GlossaryTerm.js';
import { Pill } from '../components/Pill.js';
import { extractResearchTrace } from '../presenters/researchTracePresenter.js';
import type { ResearchTraceStep, ResearchTraceSummary } from '../types.js';

interface Props {
  trace: ResearchTraceSummary;
}

/**
 * Render a research trace pulled from arbitrary metadata (session or draft).
 * Returns null when no valid trace is present so callers can just drop it in.
 */
export function ResearchTraceFromMetadata({ metadata }: { metadata: Record<string, unknown> | undefined | null }) {
  const trace = extractResearchTrace(metadata);
  if (!trace) return null;
  return <ResearchTracePanel trace={trace} />;
}

export function ResearchTracePanel({ trace }: Props) {
  return (
    <div class="panel" data-testid="research-trace">
      <header class="row between">
        <h3>
          <GlossaryTerm termKey="research_trace">Research trace</GlossaryTerm>
        </h3>
        <div class="row">
          <Pill kind={trace.derived ? 'muted' : 'accent'}>
            {trace.derived ? 'auto-derived' : 'agent-supplied'}
          </Pill>
          <Pill kind="muted">{trace.bytes} bytes</Pill>
        </div>
      </header>
      {trace.outcome && <p class="small">{trace.outcome}</p>}
      <ol class="bare" data-testid="research-trace-steps">
        {trace.steps.map((step, i) => (
          <li class="card" key={i} style={{ marginBottom: 6, borderLeft: `3px solid ${stepColor(step.kind)}`, paddingLeft: 12 }}>
            <div class="card-header">
              <div style={{ minWidth: 0, flex: 1 }}>
                <Pill kind={stepKind(step.kind)}>{step.kind}</Pill>
                <span class="small" style={{ marginLeft: 8 }}>{step.text}</span>
              </div>
            </div>
            {step.references && step.references.length > 0 && (
              <ul class="bullets small muted">
                {step.references.map((ref, j) => (
                  <li key={j}>{renderReference(ref)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function renderReference(ref: NonNullable<ResearchTraceStep['references']>[number]) {
  if (ref.file) return <code>file:{ref.file}</code>;
  if (ref.symbol) return <code>symbol:{ref.symbol}</code>;
  if (ref.command) return <code>cmd:{ref.command}</code>;
  if (ref.knowledgeId) return <code>knowledge:{ref.knowledgeId}</code>;
  return null;
}

function stepColor(kind: ResearchTraceStep['kind']): string {
  switch (kind) {
    case 'thought':     return '#888';
    case 'action':      return '#4a90e2';
    case 'observation': return '#2c8a3c';
    case 'decision':    return '#d18b18';
  }
}

function stepKind(kind: ResearchTraceStep['kind']): 'accent' | 'good' | 'warn' | 'muted' {
  if (kind === 'action') return 'accent';
  if (kind === 'observation') return 'good';
  if (kind === 'decision') return 'warn';
  return 'muted';
}
