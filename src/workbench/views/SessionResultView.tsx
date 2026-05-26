import type { AgentSessionStartResult, SessionResultViewModel } from '../types.js';
import { presentSessionResult } from '../presenters/sessionResultPresenter.js';
import { VerdictBand } from '../components/VerdictBand.js';
import { PipelineRail } from '../components/PipelineRail.js';
import { EvidenceGraph } from '../components/EvidenceGraph.js';
import { ContextStack } from '../components/ContextStack.js';
import { AgentHandoff } from '../components/AgentHandoff.js';
import { MissingContextPanel } from '../components/MissingContextPanel.js';
import { SessionActions } from '../components/SessionActions.js';

interface Props {
  result: AgentSessionStartResult;
  onChanged: () => void;
}

export function SessionResultView({ result, onChanged }: Props) {
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
      <MissingContextPanel project={view.project ?? ''} missing={view.missingSignals} onIngested={onChanged} />
      <SessionActions sessionId={view.sessionId} onChanged={onChanged} />
    </section>
  );
}
