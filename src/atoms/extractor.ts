import type { ModelProvider } from '../model/provider.js';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom, KnowledgeAtomInput } from '../types/atoms.js';
import { AtomCritic } from './critic.js';

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
}

export class AtomExtractor {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly models: ModelProvider,
    private readonly critic: AtomCritic,
  ) {}

  async extractFromSession(input: ExtractFromSessionInput): Promise<ExtractFromSessionResult> {
    if (!this.models.extractAtoms) {
      return { stored: [], rejected: [] };
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

    for (const candidate of candidates) {
      const candidateInput: KnowledgeAtomInput = {
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
      const result = await this.critic.evaluate(candidateInput);
      if (result.ok) {
        stored.push(await this.store.createAtom(candidateInput));
      } else {
        rejected.push({ candidate: candidateInput, reasons: result.reasons });
      }
    }

    return { stored, rejected };
  }
}
