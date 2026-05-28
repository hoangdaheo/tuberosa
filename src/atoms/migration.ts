import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtomInput } from '../types/atoms.js';
import type { StoredKnowledge } from '../types.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import { AtomCritic, atomEmbeddingText } from './critic.js';
import { redactAtomInput } from './redaction.js';
import { syncAtomLinks } from './inference/sync.js';

export const MIGRATABLE_ITEM_TYPES = new Set(['memory', 'bugfix', 'rule']);

export type LegacyStatus = 'legacy_replaced' | 'legacy_archived';

export interface MigrationOptions {
  project?: string;
  dryRun?: boolean;
  batchSize?: number;
}

export interface MigrationReport {
  scanned: number;
  atomsCreated: number;
  legacyReplaced: number;
  legacyArchived: number;
  failures: Array<{ knowledgeId: string; reason: string }>;
}

function alreadyMigrated(item: StoredKnowledge): boolean {
  const metadata = item.metadata ?? {};
  return Boolean(metadata.migratedAt) || Boolean(metadata.legacyStatus);
}

/**
 * Scan legacy knowledge items (memory/bugfix/rule), re-extract atoms via the
 * model provider, run them through the critic, store survivors with
 * parentKnowledgeId set to the legacy item, and mark the legacy item
 * legacy_replaced (atoms produced) or legacy_archived (none produced).
 *
 * In dryRun mode the report still counts candidate atoms as created, but no
 * atoms are written and no legacy item is updated.
 */
export async function migrateLegacyKnowledge(
  store: KnowledgeStore,
  models: ModelProvider,
  critic: AtomCritic,
  options: MigrationOptions = {},
): Promise<MigrationReport> {
  const report: MigrationReport = {
    scanned: 0,
    atomsCreated: 0,
    legacyReplaced: 0,
    legacyArchived: 0,
    failures: [],
  };

  // Production providers (no LLM extraction) are a safe no-op.
  if (!models.extractAtoms) {
    return report;
  }

  const dryRun = options.dryRun ?? false;
  const limit = options.batchSize ?? 500;
  const safety = new KnowledgeSafetyService();
  const items = await store.listKnowledge({ project: options.project, limit });

  for (const item of items) {
    if (!MIGRATABLE_ITEM_TYPES.has(item.itemType)) {
      continue;
    }
    if (alreadyMigrated(item)) {
      continue;
    }

    report.scanned += 1;

    let produced = 0;
    try {
      const candidates = await models.extractAtoms({
        project: item.project,
        sessionPrompt: item.title,
        summary: item.summary,
      });

      for (const candidate of candidates) {
        const rawInput: KnowledgeAtomInput = {
          project: item.project,
          parentKnowledgeId: item.id,
          claim: candidate.claim,
          type: candidate.type,
          evidence: candidate.evidence as KnowledgeAtomInput['evidence'],
          trigger: candidate.trigger,
          verification: candidate.verification,
          pitfalls: candidate.pitfalls,
          producedBy: 'migration_llm',
        };
        // Redact secrets before the critic embeds and before storage.
        const candidateInput = redactAtomInput(rawInput, safety);
        const result = await critic.evaluate(candidateInput);
        if (!result.ok) {
          continue;
        }
        produced += 1;
        report.atomsCreated += 1;
        if (!dryRun) {
          const embedding = await models.embed(atomEmbeddingText(candidateInput));
          const created = await store.createAtom({ ...candidateInput, embedding });
          // Concern C1 — mirror the implicit "atom supersedes legacy item" edge
          // into knowledge_relations so the graph walker can follow it. The
          // target lives in knowledge_items, not knowledge_atoms — flag it via
          // targetKind: 'knowledge'.
          await syncAtomLinks(
            created.id,
            [{ toAtomId: item.id, kind: 'supersedes', confidence: 1.0, targetKind: 'knowledge' }],
            store,
            'migration',
          );
        }
      }
    } catch (error) {
      report.failures.push({
        knowledgeId: item.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const legacyStatus: LegacyStatus = produced > 0 ? 'legacy_replaced' : 'legacy_archived';
    if (legacyStatus === 'legacy_replaced') {
      report.legacyReplaced += 1;
    } else {
      report.legacyArchived += 1;
    }

    if (!dryRun) {
      await store.updateKnowledge(item.id, {
        metadata: {
          ...(item.metadata ?? {}),
          legacyStatus,
          migratedAt: new Date().toISOString(),
        },
      });
    }
  }

  return report;
}
