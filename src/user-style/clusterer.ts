import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import { cosineSimilarity } from '../util/vector.js';

export interface ClusterUserCorrectionsOptions {
  userId: string;
  windowDays: number;
  minClusterEvents: number;
  /** Cosine threshold for single-link clustering. Default 0.85. */
  similarityThreshold?: number;
}

export interface ClusterReport {
  scannedEvents: number;
  clusters: number;
  proposalsCreated: number;
}

const NEGATIVE_FEEDBACK_TYPES = new Set(['rejected', 'irrelevant', 'stale', 'selected_but_noisy']);

/**
 * Concern F — cluster negative-feedback events tagged with the current user
 * across the given window and turn each sufficiently-large cluster into a
 * `user_style_candidate` learning proposal. Proposals are reviewed by a human
 * (workbench) before becoming user-style atoms; this job never writes atoms
 * directly.
 */
export async function clusterUserCorrections(
  store: KnowledgeStore,
  models: ModelProvider,
  options: ClusterUserCorrectionsOptions,
): Promise<ClusterReport> {
  const cutoff = Date.now() - options.windowDays * 24 * 60 * 60 * 1000;
  const threshold = options.similarityThreshold ?? 0.85;
  const events = (await store.listFeedbackEvents({ limit: 5000 }))
    .filter((e) => NEGATIVE_FEEDBACK_TYPES.has(e.feedbackType))
    .filter((e) => (e.metadata as { userId?: string } | undefined)?.userId === options.userId)
    .filter((e) => new Date(e.createdAt).getTime() >= cutoff)
    .filter((e) => Boolean(e.reason));

  if (events.length === 0) {
    return { scannedEvents: 0, clusters: 0, proposalsCreated: 0 };
  }

  const embedded = await Promise.all(
    events.map(async (e) => ({ event: e, embedding: await models.embed(e.reason ?? '') })),
  );

  // Single-link greedy clustering: each item joins the first existing cluster
  // whose centroid (first item) is within threshold; otherwise seeds a new one.
  const clusters: Array<typeof embedded> = [];
  for (const item of embedded) {
    let placed = false;
    for (const cluster of clusters) {
      const centroid = cluster[0].embedding;
      if (cosineSimilarity(centroid, item.embedding) >= threshold) {
        cluster.push(item);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([item]);
  }

  let proposalsCreated = 0;
  for (const cluster of clusters) {
    if (cluster.length < options.minClusterEvents) continue;
    const claim = cluster[0].event.reason ?? '';
    const quotes = cluster.map((c) => c.event.reason ?? '').slice(0, 6);
    await store.createLearningProposal({
      proposalType: 'user_style_candidate',
      reason: `Clustered ${cluster.length} corrections for user ${options.userId}: ${claim}`,
      evidence: quotes,
      metadata: {
        source: 'user_style_clusterer',
        userId: options.userId,
        defaultPriority: 'coding_preference',
        sampleFeedbackIds: cluster.map((c) => c.event.id),
      },
    });
    proposalsCreated += 1;
  }

  return { scannedEvents: events.length, clusters: clusters.length, proposalsCreated };
}
