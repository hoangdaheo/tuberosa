import { toPackVM, type PackVM, type PackSectionVM } from './pack-timeline-vm.js';
import { KnowledgeItem } from './KnowledgeItem.js';

export { toPackVM };
export type { Pack, PackVM, PackSectionVM, PackItem } from './pack-timeline-vm.js';

const SECTION_TONE: Record<string, string> = {
  essential: '',
  supporting: 'warm',
  optional: 'neutral',
};

export function PackTimeline({ vm }: { vm: PackVM }) {
  const sections: Array<[string, PackSectionVM]> = [
    ['essential', vm.essential],
    ['supporting', vm.supporting],
    ['optional', vm.optional],
  ];
  const totalTokens = vm.totals.tokens || 1;
  return (
    <div style="display:flex;flex-direction:column;gap:var(--space-3)">
      {sections.map(([label, s]) => {
        const fraction = totalTokens ? (s.tokens / totalTokens) * 100 : 0;
        return (
          <div key={label} class="card" style="padding:14px 16px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
              <strong
                style="font-family:var(--font-display);font-weight:500;font-size:16px;letter-spacing:-0.005em;text-transform:lowercase"
              >
                {label}
              </strong>
              <span class="pill" data-tone={SECTION_TONE[label]}>
                {s.count} · {s.tokens.toLocaleString()} tok
              </span>
            </div>
            <div
              style="position:relative;height:4px;background:var(--ink-2);border-radius:2px;margin-top:10px;overflow:hidden"
            >
              <div
                style={`position:absolute;inset:0;width:${fraction}%;background:linear-gradient(90deg,var(--copper),var(--terracotta));border-radius:2px`}
              />
            </div>
            {s.items.length > 0 && (
              <ul style="margin:10px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px">
                {s.items.map((i) => (
                  <li key={i.id} class="fade-in">
                    <KnowledgeItem id={i.id} title={i.title} tokens={i.tokens} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      <div style="text-align:right;color:var(--paper-3);font-family:var(--font-mono);font-size:var(--fs-overline);letter-spacing:0.08em">
        TOTAL · {vm.totals.tokens.toLocaleString()} tokens
      </div>
    </div>
  );
}
