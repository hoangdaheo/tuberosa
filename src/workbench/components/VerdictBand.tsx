import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-preact';
import type { SessionVerdictView } from '../types.js';
import { Pill } from './Pill.js';

export function VerdictBand({ verdict }: { verdict: SessionVerdictView }) {
  const Icon = verdict.status === 'ready' ? CheckCircle2 : verdict.status === 'insufficient' ? AlertTriangle : HelpCircle;
  return (
    <section class={`verdict-band ${verdict.status}`} data-testid="verdict-band">
      <Icon size={22} aria-hidden="true" />
      <div>
        <h1>{verdict.headline}</h1>
        <p>{verdict.detail}</p>
      </div>
      <Pill kind={verdict.status === 'ready' ? 'good' : verdict.status === 'insufficient' ? 'bad' : 'warn'}>
        {verdict.policyAction}
      </Pill>
    </section>
  );
}
