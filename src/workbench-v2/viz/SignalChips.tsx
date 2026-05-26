import { toSignalChips, type Chip } from './signal-chips-vm.js';

export { toSignalChips };
export type { Chip, ClassifierLike } from './signal-chips-vm.js';

const TONE: Record<Chip['kind'], string> = {
  task: 'neutral',
  symbol: '',
  file: 'neutral',
  error: 'bad',
  tech: 'neutral',
  area: 'warm',
};

export function SignalChips({ chips, animate = true }: { chips: Chip[]; animate?: boolean }) {
  if (chips.length === 0) {
    return (
      <span style="color:var(--paper-3);font-size:var(--fs-small);font-style:italic">
        no signals detected
      </span>
    );
  }
  return (
    <div class="row-chips">
      {chips.map((c, i) => (
        <span
          key={`${c.kind}:${c.label}:${i}`}
          class={`pill ${animate ? 'fade-in' : ''}`}
          data-tone={TONE[c.kind]}
          style={`animation-delay:${i * 60}ms`}
        >
          <span style="opacity:.55;margin-right:4px">{c.kind}</span>
          {c.label}
        </span>
      ))}
    </div>
  );
}
