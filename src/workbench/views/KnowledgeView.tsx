import { useEffect, useState } from 'preact/hooks';
import { api } from '../state/api.js';
import { pushToast } from '../state/store.js';
import type { KnowledgeItem } from '../types.js';
import { EmptyState } from '../components/EmptyState.js';
import { Pill } from '../components/Pill.js';

export function KnowledgeView({ project, limit }: { project: string; limit: number }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);

  async function load() {
    try {
      setItems(await api<KnowledgeItem[]>('/knowledge', { query: { project: project || undefined, limit, status: 'approved', q: query || undefined } }));
    } catch (err) {
      pushToast(err instanceof Error ? err.message : String(err), 'bad');
    }
  }

  useEffect(() => { load(); }, [project, limit]);

  return (
    <section class="knowledge-view" data-testid="knowledge-view">
      <h1>Knowledge</h1>
      <p class="muted">Inspect approved knowledge, trust, labels, references, and source.</p>
      <div class="inline-filter">
        <input type="search" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} placeholder="Search title or content" />
        <button onClick={load}>Search</button>
      </div>
      {items === null ? <p class="muted">Loading...</p> : items.length === 0 ? <EmptyState title="No knowledge found" hint="Add project docs or source files." /> : items.map((item) => (
        <article class="knowledge-card" key={item.id}>
          <div class="row between">
            <h3>{item.title}</h3>
            <Pill kind={item.trustLevel >= 80 ? 'good' : item.trustLevel >= 50 ? 'warn' : 'muted'}>trust {item.trustLevel}</Pill>
          </div>
          <p>{item.summary}</p>
          <p class="small muted">{item.itemType} · {item.labels.length} labels · {item.references.length} references</p>
        </article>
      ))}
    </section>
  );
}
