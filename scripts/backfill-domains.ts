import { createAppServices } from '../src/app.js';
import type { LabelInput } from '../src/types.js';

interface BackfillEntry {
  id: string;
  domain: string;
  title: string;
}

const BACKFILLS: BackfillEntry[] = [
  { id: '02d0b84a-7531-4cd7-8c80-c77e30b15e86', domain: 'operations', title: 'Own backup schedulers' },
  { id: 'd72d2bc0-b458-41d1-aff1-c9f96361260a', domain: 'operations', title: 'Debounce physical mirror' },
  { id: '1df67fc0-f601-422d-8cda-b8d0631a3488', domain: 'storage', title: 'Serialize Docker startup migrations' },
];

async function main(): Promise<void> {
  const services = await createAppServices();
  try {
    const results: Array<{ id: string; title: string; status: string; before?: number; after?: number }> = [];

    for (const entry of BACKFILLS) {
      const existing = await services.store.getKnowledge(entry.id);
      if (!existing) {
        results.push({ id: entry.id, title: entry.title, status: 'not_found' });
        continue;
      }

      const before = existing.labels.length;
      const alreadyHasDomain = existing.labels.some(
        (label) => label.type === 'domain' && label.value === entry.domain,
      );
      if (alreadyHasDomain) {
        results.push({ id: entry.id, title: existing.title, status: 'already_labeled', before, after: before });
        continue;
      }

      const labels: LabelInput[] = [
        ...existing.labels,
        { type: 'domain', value: entry.domain, weight: 1 },
      ];
      const updated = await services.store.updateKnowledge(entry.id, { labels });
      results.push({
        id: entry.id,
        title: existing.title,
        status: 'labeled',
        before,
        after: updated?.labels.length ?? before,
      });
    }

    console.log(JSON.stringify({ backfilled: results }, null, 2));
  } finally {
    await services.close();
  }
}

await main();
