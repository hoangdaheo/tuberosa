import type { AgentSessionStartResult, SessionResultViewModel } from '../types.js';
import { presentSessionResult } from '../presenters/sessionResultPresenter.js';
import { VerdictBand } from '../components/VerdictBand.js';
import { PipelineRail } from '../components/PipelineRail.js';
import { EvidenceGraph } from '../components/EvidenceGraph.js';
import { ContextStack } from '../components/ContextStack.js';
import { AgentHandoff } from '../components/AgentHandoff.js';

interface Props {
  result: AgentSessionStartResult;
}

export function SessionResultView({ result }: Props) {
  const view: SessionResultViewModel = presentSessionResult(result);
  return (
    <section class="session-result-view" data-testid="session-result-view">
      <VerdictBand verdict={view.verdict} />
      <div class="session-visual-grid">
        <PipelineRail stages={view.pipeline} />
        <EvidenceGraph graph={view.graph} />
      </div>
      <ContextStack stack={view.contextStack} />
      <AgentHandoff handoff={view.handoff} />
    </section>
  );
}
