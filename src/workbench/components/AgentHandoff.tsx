import { Clipboard } from 'lucide-preact';
import type { AgentHandoffView } from '../types.js';
import { pushToast } from '../state/store.js';

export function AgentHandoff({ handoff }: { handoff: AgentHandoffView }) {
  async function copy() {
    await navigator.clipboard.writeText(handoff.text);
    pushToast('Agent handoff copied.', 'good');
  }
  return (
    <section class="visual-panel" data-testid="agent-handoff">
      <div class="section-heading row between">
        <div>
          <h2>Agent handoff</h2>
          <p class="muted small">Copy this into Codex, Claude, Cursor, or another agent when you want a clean handoff.</p>
        </div>
        <button class="icon-button" onClick={copy}><Clipboard size={16} aria-hidden="true" /> Copy</button>
      </div>
      <pre><code>{handoff.text}</code></pre>
    </section>
  );
}
