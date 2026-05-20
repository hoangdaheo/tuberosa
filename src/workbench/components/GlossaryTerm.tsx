import type { ComponentChildren } from 'preact';
import { TERMS, type TermKey } from '../glossary/terms.js';
import { navigate } from '../state/store.js';

interface Props {
  termKey: TermKey;
  children?: ComponentChildren;
}

export function GlossaryTerm({ termKey, children }: Props) {
  const term = TERMS[termKey];
  if (!term) return <>{children}</>;
  const labelText = children ?? term.label.toLowerCase();
  return (
    <span class="term" tabIndex={0} role="button" aria-describedby={`tip-${termKey}`}>
      {labelText}
      <span class="tooltip" id={`tip-${termKey}`} role="tooltip">
        <strong>{term.label}</strong>
        {term.short}
        {' '}
        <a
          href={`#/guide?term=${termKey}`}
          onClick={(e) => {
            e.preventDefault();
            navigate('guide');
            requestAnimationFrame(() => {
              const el = document.getElementById(`term-${termKey}`);
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
          }}
        >Learn more →</a>
      </span>
    </span>
  );
}
