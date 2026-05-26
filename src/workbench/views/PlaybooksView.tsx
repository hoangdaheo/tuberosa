import { getPlaybook, listPlaybooks } from '../presenters/playbookPresenter.js';
import { navigate } from '../state/store.js';
import type { ViewName } from '../state/routes.js';

export function PlaybooksView({ playbookId }: { playbookId?: string }) {
  const playbooks = listPlaybooks();
  const active = getPlaybook(playbookId) ?? playbooks[0];
  return (
    <section class="playbooks-view" data-testid="playbooks-view">
      <div class="section-heading">
        <h1>Playbooks</h1>
        <p class="muted">Learn Tuberosa through practical workflows and examples.</p>
      </div>
      <div class="playbook-layout">
        <nav class="playbook-list">
          {playbooks.map((playbook) => (
            <button class={playbook.id === active.id ? 'active' : ''} key={playbook.id} onClick={() => navigate({ view: 'playbooks', playbookId: playbook.id })}>
              <strong>{playbook.title}</strong>
              <span>{playbook.summary}</span>
            </button>
          ))}
        </nav>
        <article class="playbook-detail">
          <h2>{active.title}</h2>
          <p>{active.summary}</p>
          {active.steps.map((step, index) => (
            <section class="playbook-step" key={step.title}>
              <span>{index + 1}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                {step.example && <pre><code>{step.example}</code></pre>}
                {step.action && <button class="primary" onClick={() => navigate(actionRoute(step.action!.kind))}>{step.action.label}</button>}
              </div>
            </section>
          ))}
        </article>
      </div>
    </section>
  );
}

function actionRoute(kind: 'open_start' | 'open_review' | 'open_system'): ViewName {
  if (kind === 'open_review') return 'review';
  if (kind === 'open_system') return 'system';
  return 'start';
}
