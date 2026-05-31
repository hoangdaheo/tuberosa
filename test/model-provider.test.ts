import test from 'node:test';
import { deepEqual, equal, ok } from 'node:assert/strict';
import {
  buildOpenAiRerankPayload,
  OPENAI_RERANK_SYSTEM_PROMPT,
} from '../src/model/provider.js';
import type { ClassifiedQuery, RankedCandidate } from '../src/types.js';

test('OpenAI rerank prompt and payload emphasize concrete retrieval evidence', () => {
  ok(OPENAI_RERANK_SYSTEM_PROMPT.includes('concrete evidence coverage'));
  ok(OPENAI_RERANK_SYSTEM_PROMPT.includes('generic semantic similarity'));
  ok(OPENAI_RERANK_SYSTEM_PROMPT.includes('stale, superseded, rejected, irrelevant'));

  const classified: ClassifiedQuery = {
    project: 'tuberosa',
    taskType: 'implementation',
    confidence: 0.8,
    files: ['src/auth.ts'],
    symbols: ['AuthService'],
    errors: ['TS-999'],
    technologies: ['postgres'],
    businessAreas: ['auth'],
    exactTerms: ['src/auth.ts', 'AuthService', 'TS-999'],
    lexicalQuery: 'src/auth.ts AuthService TS-999 token refresh',
    intent: {
      taskGoal: 'implement requested change',
      workflowStage: 'implementation',
      impliedFiles: ['src/auth.ts'],
      impliedSymbols: ['AuthService'],
      impliedDomains: ['auth'],
      recentSessionReferences: [],
      requiredEvidenceTypes: ['code_reference', 'workflow'],
      uncertaintyReasons: [],
    },
  };
  const current = rankedCandidate({
    metadata: {
      graphPaths: [{
        relationType: 'depends_on',
        reason: 'seed_outbound',
        confidence: 0.95,
      }],
      feedback: {
        status: 'selected',
        selectedCount: 2,
      },
    },
  });
  const stale = rankedCandidate({
    knowledgeId: 'legacy-auth-memory',
    title: 'Legacy auth workflow',
    summary: 'Deprecated auth memory.',
    content: 'This stale memory used the obsolete token refresh flow.',
    metadata: { stale: true },
    matchReasons: ['vector match', 'feedback:stale:1', 'suppression:freshness:stale'],
  });

  const payload = buildOpenAiRerankPayload({
    prompt: 'Update src/auth.ts AuthService handling for TS-999 token refresh',
    classified,
    candidates: [current, stale],
  }) as {
    classified: { intent: { requiredEvidenceTypes: string[] } };
    candidates: Array<{
      knowledgeId: string;
      evidence: {
        exactFiles: string[];
        exactSymbols: string[];
        exactErrors: string[];
        exactTechnologies: string[];
        exactBusinessAreas: string[];
        taskMatch: boolean;
        projectMatch: boolean;
        requiredEvidenceTypes: string[];
        graphPaths: Array<Record<string, unknown>>;
        feedback?: Record<string, unknown>;
        freshness: { freshnessAt?: string; staleMetadata: boolean; staleLanguage: boolean };
        riskSignals: string[];
      };
    }>;
  };

  deepEqual(payload.classified.intent.requiredEvidenceTypes, ['code_reference', 'workflow']);
  const currentEvidence = payload.candidates[0]!.evidence;
  deepEqual(currentEvidence.exactFiles, ['src/auth.ts']);
  deepEqual(currentEvidence.exactSymbols, ['AuthService']);
  deepEqual(currentEvidence.exactErrors, ['TS-999']);
  deepEqual(currentEvidence.exactTechnologies, ['postgres']);
  deepEqual(currentEvidence.exactBusinessAreas, ['auth']);
  equal(currentEvidence.taskMatch, true);
  equal(currentEvidence.projectMatch, true);
  deepEqual(currentEvidence.requiredEvidenceTypes, ['code_reference', 'workflow']);
  equal(currentEvidence.graphPaths[0]?.relationType, 'depends_on');
  equal(currentEvidence.feedback?.status, 'selected');

  const staleEvidence = payload.candidates[1]!.evidence;
  equal(staleEvidence.freshness.staleMetadata, true);
  equal(staleEvidence.freshness.staleLanguage, true);
  deepEqual(staleEvidence.riskSignals, ['feedback:stale:1', 'suppression:freshness:stale']);
});

function rankedCandidate(overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    knowledgeId: 'auth-runbook',
    chunkId: 'chunk-auth-runbook',
    title: 'AuthService token refresh runbook',
    summary: 'Current token refresh workflow for AuthService.',
    content: 'AuthService in src/auth.ts handles TS-999 token refresh using Postgres-backed retry state.',
    contextualContent: 'Project: tuberosa\nFile: src/auth.ts\nSymbol: AuthService\nError: TS-999\nTechnology: postgres\nBusiness area: auth',
    itemType: 'code_ref',
    project: 'tuberosa',
    labels: [
      { type: 'file', value: 'src/auth.ts', weight: 1 },
      { type: 'symbol', value: 'AuthService', weight: 1 },
      { type: 'error', value: 'TS-999', weight: 1 },
      { type: 'technology', value: 'postgres', weight: 0.8 },
      { type: 'business_area', value: 'auth', weight: 0.8 },
      { type: 'task_type', value: 'implementation', weight: 0.9 },
      { type: 'workflow_stage', value: 'token-refresh', weight: 0.9 },
    ],
    references: [{ type: 'file', uri: 'src/auth.ts' }],
    tokenEstimate: 48,
    trustLevel: 90,
    source: 'metadata',
    rawScore: 1,
    rank: 1,
    fusedScore: 1,
    rerankScore: 0,
    finalScore: 1,
    matchReasons: ['metadata match', 'file:src/auth.ts', 'symbol:AuthService', 'error:TS-999'],
    freshnessAt: '2026-05-18T00:00:00.000Z',
    ...overrides,
  };
}
