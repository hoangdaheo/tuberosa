import { useState } from 'preact/hooks';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import type { MissingSignalGroups, WorkbenchIngestFilesRequest } from '../types.js';

interface Props {
  project: string;
  missing: MissingSignalGroups;
  onIngested: () => void;
}

export function MissingContextPanel({ project, missing, onIngested }: Props) {
  const [path, setPath] = useState(missing.files[0] ?? '');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const missingCount = Object.values(missing).reduce((sum, items) => sum + items.length, 0);
  if (missingCount === 0) return null;

  async function ingest() {
    if (!project || !path.trim() || !content.trim()) {
      pushToast('Project, path, and content are required to ingest missing context.', 'bad');
      return;
    }
    setBusy(true);
    try {
      const body: WorkbenchIngestFilesRequest = {
        project,
        files: [{ path: path.trim(), content: content.trim(), itemType: 'wiki', mode: 'document' }],
        mode: 'document',
      };
      await api('/ingest/files', { method: 'POST', body });
      pushToast('Missing context ingested. Retry the task to re-map context.', 'good');
      onIngested();
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class="panel missing-context" data-testid="missing-context-panel">
      <h2>Missing context</h2>
      <p class="muted small">Tuberosa can retry the same task after you add the missing project knowledge.</p>
      <div class="missing-grid">
        {Object.entries(missing).map(([kind, values]) => values.length > 0 && (
          <div key={kind}>
            <strong>{kind}</strong>
            <ul>{(values as string[]).map((value) => <li key={value}>{value}</li>)}</ul>
          </div>
        ))}
      </div>
      <div class="form-grid">
        <div class="form-row">
          <label htmlFor="missing-path">Path</label>
          <input id="missing-path" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} />
        </div>
        <div class="form-row">
          <label htmlFor="missing-content">Content</label>
          <textarea id="missing-content" value={content} onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)} />
        </div>
      </div>
      <button class="primary" disabled={busy} onClick={ingest} data-testid="ingest-missing-context">{busy ? 'Ingesting...' : 'Ingest missing context'}</button>
    </section>
  );
}
