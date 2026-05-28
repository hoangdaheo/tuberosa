import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom, KnowledgeAtomInput } from '../types/atoms.js';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import { AtomCritic, atomEmbeddingText } from './critic.js';
import { redactAtomInput } from './redaction.js';

export interface ExtractFromSessionInput {
  project: string;
  sessionId: string;
  sessionPrompt: string;
  summary?: string;
  changedFiles?: string[];
  decisions?: Array<{ decision: string; reason?: string; knowledgeIds?: string[] }>;
  verificationCommands?: string[];
}

export interface ExtractFromSessionResult {
  stored: KnowledgeAtom[];
  rejected: Array<{ candidate: KnowledgeAtomInput; reasons: string[] }>;
  /** Legacy knowledge_item ids the critic flagged as near-duplicates to migrate. */
  queuedLegacyMigrations: string[];
}

export class AtomExtractor {
  private readonly safety: KnowledgeSafetyService;

  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
    private readonly critic: AtomCritic,
    safety?: KnowledgeSafetyService,
  ) {
    this.safety = safety ?? new KnowledgeSafetyService();
  }

  async extractFromSession(input: ExtractFromSessionInput): Promise<ExtractFromSessionResult> {
    if (!this.models.extractAtoms) {
      return { stored: [], rejected: [], queuedLegacyMigrations: [] };
    }
    const candidates = await this.models.extractAtoms({
      project: input.project,
      sessionPrompt: input.sessionPrompt,
      summary: input.summary,
      changedFiles: input.changedFiles,
      decisions: input.decisions,
      verificationCommands: input.verificationCommands,
    });

    const stored: KnowledgeAtom[] = [];
    const rejected: ExtractFromSessionResult['rejected'] = [];
    const queuedLegacyMigrations: string[] = [];

    for (const candidate of candidates) {
      const rawInput: KnowledgeAtomInput = {
        project: input.project,
        claim: candidate.claim,
        type: candidate.type,
        evidence: candidate.evidence as KnowledgeAtomInput['evidence'],
        trigger: candidate.trigger,
        verification: candidate.verification,
        pitfalls: candidate.pitfalls,
        producedBy: 'agent_session',
        producedAtSessionId: input.sessionId,
      };
      // Redact secrets before the critic embeds and before storage so the
      // stored + embedded text never contains raw secrets.
      const candidateInput = redactAtomInput(rawInput, this.safety);
      const result = await this.critic.evaluate(candidateInput, input.sessionId);
      if (result.outcome === 'accepted' || result.outcome === 'pending') {
        // 'pending' means the LLM critic was unavailable for a borderline atom;
        // we keep it (fail-open) rather than dropping a potentially useful lesson.
        const embedding = await this.models.embed(atomEmbeddingText(candidateInput));
        stored.push(await this.store.createAtom({ ...candidateInput, embedding }));
      } else if (result.outcome === 'queue_legacy_migration' && result.legacyKnowledgeIdForMigration) {
        // Near-duplicate of a vague legacy memory — surface it for migration
        // instead of storing a competing atom or logging a (misleading) gap.
        queuedLegacyMigrations.push(result.legacyKnowledgeIdForMigration);
      } else {
        rejected.push({ candidate: candidateInput, reasons: result.reasons });
      }
    }

    return { stored, rejected, queuedLegacyMigrations };
  }
}
