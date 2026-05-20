import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { TERMS, type TermKey } from '../glossary/terms.js';
import { navigate } from '../state/store.js';

interface Props {
  termKey: TermKey;
  children?: ComponentChildren;
}

let tooltipCounter = 0;

export function GlossaryTerm({ termKey, children }: Props) {
  const [open, setOpen] = useState(false);
  const [tooltipId] = useState(() => `tip-${termKey}-${++tooltipCounter}`);
  const [style, setStyle] = useState<Record<string, string>>({});
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const term = TERMS[termKey];
  if (!term) return <>{children}</>;
  const labelText = children ?? term.label.toLowerCase();

  useEffect(() => {
    if (!open) return undefined;
    positionTooltip();
    const onResize = () => positionTooltip();
    const onScroll = () => positionTooltip();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function openTooltip() {
    setStyle(safeInitialStyle());
    setOpen(true);
    requestAnimationFrame(positionTooltip);
  }

  function close() {
    setOpen(false);
  }

  function positionTooltip() {
    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) return;
    const rect = anchor.getBoundingClientRect();
    const gutter = 12;
    const width = Math.min(420, Math.max(260, window.innerWidth - gutter * 2));
    const maxHeight = window.innerHeight - gutter * 2;
    const height = Math.min(tooltip.offsetHeight || tooltip.scrollHeight || 140, maxHeight);
    const maxLeft = Math.max(gutter, window.innerWidth - width - gutter);
    const left = clamp(rect.left, gutter, maxLeft);
    const below = rect.bottom + 8;
    const above = rect.top - height - 8;
    const preferredTop = below + height + gutter <= window.innerHeight ? below : above;
    const maxTop = Math.max(gutter, window.innerHeight - height - gutter);
    const top = clamp(preferredTop, gutter, maxTop);
    setStyle({
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      maxHeight: `${maxHeight}px`,
    });
  }

  return (
    <span
      ref={anchorRef}
      class="term"
      tabIndex={0}
      role="button"
      aria-describedby={tooltipId}
      aria-expanded={open}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (!next || !tooltipRef.current?.contains(next)) close();
      }}
      onClick={(event) => {
        event.preventDefault();
        open ? close() : openTooltip();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open ? close() : openTooltip();
        }
        if (event.key === 'Escape') close();
      }}
    >
      {labelText}
      <span
        ref={tooltipRef}
        class={`tooltip ${open ? 'open' : ''}`}
        id={tooltipId}
        role="tooltip"
        style={style}
        onClick={(event) => event.stopPropagation()}
      >
        <button class="tooltip-close" aria-label="Close glossary detail" onClick={close}>×</button>
        <strong>{term.label}</strong>
        {term.short}
        {' '}
        <a
          href={`#/guide?term=${termKey}`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            navigate('guide');
            close();
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function safeInitialStyle(): Record<string, string> {
  const gutter = 12;
  return {
    left: `${gutter}px`,
    top: `${gutter}px`,
    width: `${Math.min(420, Math.max(260, window.innerWidth - gutter * 2))}px`,
    maxHeight: `${window.innerHeight - gutter * 2}px`,
  };
}
