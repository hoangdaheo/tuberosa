import { GlossaryTerm } from '../components/GlossaryTerm.js';
import { Pill } from '../components/Pill.js';
import type { StartupBrief } from '../types.js';

interface Props {
  brief: StartupBrief;
}

export function StartupBriefPanel({ brief }: Props) {
  const kind = verdictKind(brief.verdict);
  return (
    <div class="panel" data-testid="startup-brief">
      <header class="row between">
        <h3>
          <GlossaryTerm termKey="startup_brief">Startup brief</GlossaryTerm>
        </h3>
        <span data-testid="startup-brief-verdict"><Pill kind={kind}>{brief.verdict}</Pill></span>
      </header>
      <p class="muted small">
        Required decision: <code>{brief.requiredContextDecision}</code>
      </p>

      {brief.readFirst.length > 0 && (
        <>
          <h4><GlossaryTerm termKey="read_first">Read first</GlossaryTerm></h4>
          <ul class="bare" data-testid="startup-brief-read-first">
            {brief.readFirst.map((row, i) => (
              <li class="card muted" key={`${row.source}-${row.path}-${i}`} style={{ marginBottom: 6 }}>
                <div class="card-header">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <code class="card-title truncate">{row.path}</code>
                    <div class="small muted">{row.reason}</div>
                  </div>
                  <Pill kind={row.source === 'worktree' ? 'accent' : 'good'}>{row.source}</Pill>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {brief.directEvidence.length > 0 && (
        <>
          <h4>Direct evidence</h4>
          <ul class="bullets small" data-testid="startup-brief-direct">
            {brief.directEvidence.map((row, i) => (
              <li key={i}>
                {row.path ? <code>{row.path}</code> : <code>{row.knowledgeId}</code>}
                <span class="muted"> — {row.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {brief.adjacentEvidence.length > 0 && (
        <>
          <h4>Adjacent evidence</h4>
          <ul class="bullets small muted" data-testid="startup-brief-adjacent">
            {brief.adjacentEvidence.map((row, i) => (
              <li key={i}>
                <code>{row.knowledgeId}</code> — {row.reason}
              </li>
            ))}
          </ul>
        </>
      )}

      {brief.missingSignals.length > 0 && (
        <>
          <h4>Missing signals</h4>
          <ul class="bullets small bad" data-testid="startup-brief-missing">
            {brief.missingSignals.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </>
      )}

      {brief.riskyAreas.length > 0 && (
        <>
          <h4>Risky areas</h4>
          <ul class="bullets small warn" data-testid="startup-brief-risky">
            {brief.riskyAreas.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </>
      )}

      {brief.verificationCommands.length > 0 && (
        <>
          <h4>Verification commands</h4>
          <ul class="bullets small" data-testid="startup-brief-verify">
            {brief.verificationCommands.map((cmd, i) => <li key={i}><code>{cmd}</code></li>)}
          </ul>
        </>
      )}
    </div>
  );
}

function verdictKind(verdict: StartupBrief['verdict']): 'good' | 'warn' | 'bad' {
  if (verdict === 'proceed') return 'good';
  if (verdict === 'confirm') return 'warn';
  return 'bad';
}
