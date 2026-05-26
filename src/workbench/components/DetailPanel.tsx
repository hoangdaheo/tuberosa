import type { ComponentChildren } from 'preact';
import { X } from 'lucide-preact';

interface Props {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ComponentChildren;
}

export function DetailPanel({ title, open, onClose, children }: Props) {
  if (!open) return null;
  return (
    <aside class="detail-panel" data-testid="detail-panel">
      <div class="row between">
        <h3>{title}</h3>
        <button class="icon-only" onClick={onClose} aria-label="Close detail"><X size={16} aria-hidden="true" /></button>
      </div>
      {children}
    </aside>
  );
}
