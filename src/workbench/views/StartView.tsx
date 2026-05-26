import { useState } from 'preact/hooks';
import { ChevronDown, PlayCircle } from 'lucide-preact';
import { api } from '../state/api.js';
import { navigate, pushToast } from '../state/store.js';
import type { AgentSessionStartResult, WorkbenchStartForm } from '../types.js';

const DEFAULT_FORM: WorkbenchStartForm = {
  prompt: '',
  project: '',
  cwd: '',
  taskType: '',
  files: '',
  symbols: '',
  errors: '',
  contextMode: 'compact',
};

interface Props {
  defaultProject: string;
  defaultCwd?: string;
  onSessionStarted: (result: AgentSessionStartResult) => void;
}

export function StartView({ defaultProject, defaultCwd = '', onSessionStarted }: Props) {
  const [form, setForm] = useState<WorkbenchStartForm>({ ...DEFAULT_FORM, project: defaultProject, cwd: defaultCwd });
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  function update<K extends keyof WorkbenchStartForm>(key: K, value: WorkbenchStartForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function mapContext(e: Event) {
    e.preventDefault();
    if (!form.prompt.trim()) {
      pushToast('Enter the task the agent is about to do.', 'bad');
      return;
    }
    setBusy(true);
    try {
      const result = await api<AgentSessionStartResult>('/agent-sessions', {
        method: 'POST',
        body: {
          prompt: form.prompt.trim(),
          project: form.project.trim() || undefined,
          cwd: form.cwd.trim() || undefined,
          taskType: form.taskType || undefined,
          contextMode: form.contextMode,
          files: splitList(form.files),
          symbols: splitList(form.symbols),
          errors: splitList(form.errors),
        },
      });
      onSessionStarted(result);
      navigate({ view: 'session', sessionId: result.session.id });
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="start-view" data-testid="start-view">
      <div class="start-copy">
        <p class="eyebrow">Real project first</p>
        <h1>Map the <em>context</em> for the task your agent is about to do.</h1>
        <p class="muted">Tuberosa will classify the task, retrieve evidence, explain confidence, and produce a handoff for Codex, Claude, Cursor, or another MCP-aware agent.</p>
      </div>
      <form class="start-card" onSubmit={mapContext} data-testid="start-form">
        <label htmlFor="start-prompt">What is the agent about to do?</label>
        <textarea
          id="start-prompt"
          data-testid="start-prompt"
          value={form.prompt}
          onInput={(e) => update('prompt', (e.target as HTMLTextAreaElement).value)}
          placeholder="Fix the build failure in src/retrieval/service.ts"
          required
        />
        <div class="form-grid">
          <div class="form-row">
            <label htmlFor="start-project">Project</label>
            <input id="start-project" value={form.project} onInput={(e) => update('project', (e.target as HTMLInputElement).value)} placeholder="tuberosa" />
          </div>
          <div class="form-row">
            <label htmlFor="start-cwd">Working directory</label>
            <input id="start-cwd" value={form.cwd} onInput={(e) => update('cwd', (e.target as HTMLInputElement).value)} placeholder="/home/nash/tuberosa" />
          </div>
        </div>
        <button class="advanced-toggle" type="button" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>
          <ChevronDown size={16} aria-hidden="true" /> Advanced signals
        </button>
        {advancedOpen && (
          <div class="advanced-panel" data-testid="start-advanced">
            <div class="form-grid">
              <div class="form-row">
                <label htmlFor="start-task-type">Task type</label>
                <select id="start-task-type" value={form.taskType} onChange={(e) => update('taskType', (e.target as HTMLSelectElement).value)}>
                  <option value="">auto</option>
                  <option value="implementation">implementation</option>
                  <option value="debugging">debugging</option>
                  <option value="refactor">refactor</option>
                  <option value="review">review</option>
                  <option value="testing">testing</option>
                  <option value="planning">planning</option>
                </select>
              </div>
              <div class="form-row">
                <label htmlFor="start-context-mode">Context mode</label>
                <select id="start-context-mode" value={form.contextMode} onChange={(e) => update('contextMode', (e.target as HTMLSelectElement).value as WorkbenchStartForm['contextMode'])}>
                  <option value="compact">compact</option>
                  <option value="layered">layered</option>
                </select>
              </div>
              <SignalInput id="start-files" label="Files" value={form.files} onInput={(value) => update('files', value)} />
              <SignalInput id="start-symbols" label="Symbols" value={form.symbols} onInput={(value) => update('symbols', value)} />
              <SignalInput id="start-errors" label="Errors" value={form.errors} onInput={(value) => update('errors', value)} />
            </div>
          </div>
        )}
        <div class="form-actions">
          <button class="primary icon-button" type="submit" disabled={busy} data-testid="map-context">
            <PlayCircle size={16} aria-hidden="true" /> {busy ? 'Mapping...' : 'Map context'}
          </button>
        </div>
      </form>
    </section>
  );
}

function SignalInput({ id, label, value, onInput }: { id: string; label: string; value: string; onInput: (value: string) => void }) {
  return (
    <div class="form-row">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onInput={(e) => onInput((e.target as HTMLInputElement).value)} placeholder="comma or newline separated" />
    </div>
  );
}

function splitList(value: string): string[] | undefined {
  const items = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}
