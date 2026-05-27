import type { ComponentChildren } from 'preact';

const TERMS: Record<string, string> = {
  fuse: 'Combine the separate ranked candidate lists into one, using weighted reciprocal-rank fusion.',
  rerank: 'Re-order the top slice of candidates with a reranker model for better precision.',
  FTS: 'Full-text search — Postgres lexical keyword matching.',
  fit: 'Context fit — the decision of whether retrieved context is ready, needs confirmation, or insufficient.',
  layered: 'Layered mode — after ranking, expand the chosen items into full source chunks within a deep-context budget.',
  reflection: 'A reviewed lesson saved after a session so the next agent reads it first.',
};

export function Term({ k, def, children }: { k?: string; def?: string; children: ComponentChildren }) {
  const text = def ?? (k ? TERMS[k] : undefined);
  if (!text) return <>{children}</>;
  return (
    <abbr
      title={text}
      aria-label={text}
      tabIndex={0}
      style="text-decoration:underline dotted;text-underline-offset:3px;cursor:help"
    >
      {children}
    </abbr>
  );
}
