import type { ComponentChildren } from 'preact';

interface Props {
  title: string;
  hint?: ComponentChildren;
}

export function EmptyState({ title, hint }: Props) {
  return (
    <div class="empty" data-testid="empty-state">
      <div style={{ fontWeight: 600 }}>{title}</div>
      {hint && <div class="small" style={{ marginTop: 8 }}>{hint}</div>}
    </div>
  );
}
