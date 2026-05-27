import { tour, setRoute, route } from '../state/store.js';
import type { ChapterId } from '../types.js';

const SCRIPT: Array<{ chapter: ChapterId; caption: string; dwellMs: number }> = [
  { chapter: 1, caption: 'Tuberosa is a context broker for coding agents.', dwellMs: 5000 },
  { chapter: 2, caption: 'Without context, an agent guesses. With Tuberosa, it cites.', dwellMs: 7000 },
  { chapter: 3, caption: 'The big picture: prompt in, three groups of context out.', dwellMs: 7000 },
  { chapter: 4, caption: 'Ten short stages do the work. Click any to look inside.', dwellMs: 10000 },
  { chapter: 5, caption: 'Knowledge lives in a graph of items and relations.', dwellMs: 8000 },
  { chapter: 6, caption: 'Each session can leave a reviewed lesson behind.', dwellMs: 7000 },
  { chapter: 7, caption: 'Try ten curated prompts to see every branch.', dwellMs: 6000 },
  { chapter: 8, caption: 'Wire your agent in. One snippet per editor.', dwellMs: 6000 },
  { chapter: 9, caption: 'Inspect your own sessions from this checkout.', dwellMs: 6000 },
  { chapter: 10, caption: 'Review queues and operate the system.', dwellMs: 6000 },
];

const reducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let timer: number | null = null;

function clear(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function step(i: number): void {
  if (i >= SCRIPT.length) {
    tour.value = { playing: false, index: 0 };
    return;
  }
  const s = SCRIPT[i];
  tour.value = { playing: true, index: i };
  setRoute({ ...route.value, chapter: s.chapter }, true);
  document
    .getElementById(`ch${s.chapter}`)
    ?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
  timer = setTimeout(() => step(i + 1), s.dwellMs) as unknown as number;
}

export function startTour(): void {
  clear();
  step(0);
}

export function AutoTour() {
  const t = tour.value;
  const caption = t.playing
    ? SCRIPT[t.index]?.caption ?? ''
    : 'Take the guided tour — about a minute.';
  return (
    <div class="auto-tour">
      <span class="caption">{caption}</span>
      {!t.playing ? (
        <button
          class="primary"
          onClick={() => {
            clear();
            step(0);
          }}
        >
          ▶ Tour
        </button>
      ) : (
        <>
          <button
            class="ghost"
            onClick={() => {
              clear();
              tour.value = { playing: false, index: t.index };
            }}
            aria-label="Pause tour"
          >
            ⏸
          </button>
          <button
            class="ghost"
            onClick={() => {
              clear();
              tour.value = { playing: false, index: 0 };
            }}
            aria-label="End tour"
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}
