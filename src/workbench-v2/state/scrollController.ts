import { signal } from '@preact/signals';
import type { ChapterId } from '../types.js';
import { setRoute, route } from './store.js';

export const activeChapter = signal<ChapterId>(1);

export function observeChapter(el: HTMLElement, chapter: ChapterId): () => void {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.intersectionRatio > 0.4) {
          activeChapter.value = chapter;
          if (route.value.chapter !== chapter) {
            setRoute({ ...route.value, chapter }, true);
          }
        }
      }
    },
    { threshold: [0.4, 0.6] },
  );
  io.observe(el);
  return () => io.disconnect();
}
