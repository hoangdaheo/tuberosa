import { toPackVM, type Pack, type PackVM, type PackSectionVM } from './pack-timeline-vm.js';

export { toPackVM };
export type { Pack, PackVM, PackSectionVM, PackItem } from './pack-timeline-vm.js';

export function PackTimeline({ vm }: { vm: PackVM }) {
  const sections: Array<[string, PackSectionVM]> = [
    ['essential', vm.essential],
    ['supporting', vm.supporting],
    ['optional', vm.optional],
  ];
  return (
    <div style="display:flex;flex-direction:column;gap:8px">
      {sections.map(([label, s]) => (
        <div key={label} class="card">
          <div style="display:flex;justify-content:space-between">
            <strong>{label}</strong>
            <span class="pill">
              {s.count} items · {s.tokens} tok
            </span>
          </div>
          <ul style="margin:8px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px">
            {s.items.map((i) => (
              <li key={i.id} class="fade-in">
                <span class="code">{i.id}</span> {i.title}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div style="text-align:right;color:var(--fg-muted);font-size:12px">
        total {vm.totals.tokens} tokens
      </div>
    </div>
  );
}
