import { toSignalChips, type Chip } from './signal-chips-vm.js';

export { toSignalChips };
export type { Chip, ClassifierLike } from './signal-chips-vm.js';

const TONE: Record<Chip['kind'], string> = {
  task: '',
  symbol: '',
  file: '',
  error: 'bad',
  tech: '',
  area: 'warm',
};

export function SignalChips({ chips, animate = true }: { chips: Chip[]; animate?: boolean }) {
  return (
    <div style="display:flex;flex-wrap:wrap;gap:6px">
      {chips.map((c, i) => (
        <span
          key={`${c.kind}:${c.label}:${i}`}
          class={`pill ${animate ? 'fade-in' : ''}`}
          data-tone={TONE[c.kind]}
          style={`animation-delay:${i * 60}ms`}
        >
          <span style="opacity:.7">{c.kind}:</span>
          {c.label}
        </span>
      ))}
    </div>
  );
}
