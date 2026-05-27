import { activeChapter } from '../state/scrollController.js';
import { setRoute, route } from '../state/store.js';
import type { ChapterId } from '../types.js';

const TITLES: Record<ChapterId, string> = {
  1: 'Hello',
  2: 'Problem',
  3: 'Anatomy',
  4: 'Pipeline',
  5: 'Graph',
  6: 'Reflect',
  7: 'Try it',
  8: 'Plug in',
  9: 'Sessions',
  10: 'Tune',
};

const CHAPTERS: ChapterId[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function ProgressRail() {
  const active = activeChapter.value;
  const pct = (active / CHAPTERS.length) * 100;
  return (
    <nav class="progress-rail" aria-label="Chapters">
      <div
        class="progress-rail-fill"
        role="progressbar"
        aria-valuenow={active}
        aria-valuemin={1}
        aria-valuemax={CHAPTERS.length}
        style={`position:absolute;left:0;top:0;width:2px;height:${pct}%;background:var(--copper);transition:height var(--anim-med)`}
      />
      <ol>
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
            >
              <strong>{n}</strong>
              <span>{TITLES[n]}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
