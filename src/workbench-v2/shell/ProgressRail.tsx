import { activeChapter } from '../state/scrollController.js';
import { setRoute, route } from '../state/store.js';
import type { ChapterId } from '../types.js';

const TITLES: Record<ChapterId, string> = {
  1: 'Hello',
  2: 'Problem',
  3: 'Anatomy',
  4: 'Pipeline',
  5: 'Graph',
  6: 'Reflections',
  7: 'Try it',
  8: 'Plug in',
  9: 'Your sessions',
  10: 'Tune & operate',
};

const CHAPTERS: ChapterId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function ProgressRail() {
  const active = activeChapter.value;
  return (
    <nav class="progress-rail" aria-label="Chapters">
      <ol style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:8px">
        {CHAPTERS.map((n) => (
          <li key={n}>
            <a
              href={`#/ch${n}`}
              onClick={(e) => {
                e.preventDefault();
                setRoute({ ...route.value, chapter: n });
                document.getElementById(`ch${n}`)?.scrollIntoView({ behavior: 'smooth' });
              }}
              aria-current={active === n ? 'true' : undefined}
              style={`display:block;text-align:center;padding:6px 0;border-radius:6px;color:${active === n ? 'var(--accent)' : 'var(--fg-muted)'};font-size:11px;text-decoration:none`}
            >
              <strong style="display:block;font-size:13px">{n}</strong>
              <span style="display:block;font-size:10px">{TITLES[n]}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
