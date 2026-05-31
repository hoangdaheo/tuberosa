import type { KnowledgeStore } from '../storage/store.js';
import type {
  AgentContextCompliance,
  AgentContextDecision,
  AgentSession,
  AgentSessionOutcome,
  ContextPack,
  ReferenceInput,
  ReflectionDraft,
} from '../types.js';

export type LearningMode = 'auto' | 'draft_only' | 'off';

export type GateKey =
  | 'learning_mode'
  | 'session_outcome'
  | 'compliance'
  | 'context_fit'
  | 'negative_decisions'
  | 'noisy_feedback'
  | 'signal_confidence'
  | 'duplicates'
  | 'grounded_references'
  | 'concrete_labels'
  | 'draft_maturity'
  | 'distillation_evidence'
  | 'write_gate';

export type GateStatus = 'pass' | 'fail' | 'unknown';

export type GateSeverity = 'soft' | 'hard';

export interface GateResult {
  key: GateKey;
  status: GateStatus;
  severity: GateSeverity;
  label: string;
  message: string;
  detail?: string;
}

export interface EvaluateGatesInput {
  draft: ReflectionDraft;
  mode?: LearningMode;
  outcome?: AgentSessionOutcome;
  compliance?: AgentContextCompliance;
  decisions?: AgentContextDecision[];
  selectedPack?: ContextPack;
}

export type RecommendationVerdict = 'approve' | 'needs_changes' | 'reject';

export type RecommendationConfidence = 'high' | 'medium' | 'low';

export interface RecommendationPoint {
  key: GateKey;
  label: string;
  detail: string;
}

export interface DraftRecommendation {
  draftId: string;
  verdict: RecommendationVerdict;
  confidence: RecommendationConfidence;
  oneLineRationale: string;
  pros: RecommendationPoint[];
  cons: RecommendationPoint[];
  blockers: RecommendationPoint[];
  unknowns: RecommendationPoint[];
  gates: GateResult[];
  canAutoApprove: boolean;
}

const HARD_GATES: ReadonlySet<GateKey> = new Set([
  'duplicates',
  'grounded_references',
  'signal_confidence',
  'distillation_evidence',
  'write_gate',
]);

export function evaluateGates(input: EvaluateGatesInput): GateResult[] {
  return [
    gateLearningMode(input),
    gateSessionOutcome(input),
    gateCompliance(input),
    gateContextFit(input),
    gateNegativeDecisions(input),
    gateNoisyFeedback(input),
    gateSignalConfidence(input),
    gateDuplicates(input),
    gateGroundedReferences(input),
    gateConcreteLabels(input),
    gateDraftMaturity(input),
    gateDistillationEvidence(input),
    gateWriteGate(input),
  ];
}

function gateLearningMode(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'learning_mode';
  const severity: GateSeverity = 'soft';
  if (input.mode === undefined) {
    return { key, status: 'unknown', severity, label: 'Auto-learning mode', message: 'Mode is not recorded on the draft.' };
  }

  if (input.mode === 'auto') {
    return { key, status: 'pass', severity, label: 'Auto-learning mode', message: 'Auto-learning was enabled when this draft was created.' };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Auto-learning mode',
    message: input.mode === 'off'
      ? 'Auto-learning was disabled — this draft requires human approval.'
      : 'Draft-only mode — auto-approval is intentionally turned off.',
    detail: `mode: ${input.mode}`,
  };
}

function gateSessionOutcome(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'session_outcome';
  const severity: GateSeverity = 'soft';
  if (input.outcome === undefined) {
    return { key, status: 'unknown', severity, label: 'Session outcome', message: 'The originating session outcome is not linked.' };
  }

  if (input.outcome === 'completed') {
    return { key, status: 'pass', severity, label: 'Session outcome', message: 'The agent task completed successfully — lessons from successful runs are usually safer to keep.' };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Session outcome',
    message: `Session ended as ${input.outcome}, not completed. Lessons from incomplete runs may be premature.`,
  };
}

function gateCompliance(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'compliance';
  const severity: GateSeverity = 'soft';
  if (!input.compliance) {
    return { key, status: 'unknown', severity, label: 'Context coverage', message: 'No compliance record is attached to this draft.' };
  }

  if (input.compliance.status === 'compliant') {
    return { key, status: 'pass', severity, label: 'Context coverage', message: 'The agent confirmed it used the suggested context before finishing.' };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Context coverage',
    message: `Context coverage is "${input.compliance.status}" — the agent may not have used the right context for this lesson.`,
    detail: input.compliance.instruction,
  };
}

function gateContextFit(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'context_fit';
  const severity: GateSeverity = 'soft';
  const fitFromPack = input.selectedPack?.contextFit?.fitStatus;
  const fitFromMetadata = typeof (input.draft.metadata as { contextFit?: { fitStatus?: string } })?.contextFit?.fitStatus === 'string'
    ? (input.draft.metadata as { contextFit?: { fitStatus?: string } }).contextFit!.fitStatus
    : undefined;
  const fit = fitFromPack ?? fitFromMetadata;

  if (!fit) {
    return { key, status: 'unknown', severity, label: 'Context fit', message: 'No context-fit signal is recorded for this draft.' };
  }

  if (fit === 'ready') {
    return { key, status: 'pass', severity, label: 'Context fit', message: 'The retrieved context was rated "ready" for the task.' };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Context fit',
    message: `Context fit was "${fit}" — the agent worked with thin context, so the lesson may be partial.`,
  };
}

function gateNegativeDecisions(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'negative_decisions';
  const severity: GateSeverity = 'soft';
  if (input.decisions === undefined) {
    return { key, status: 'unknown', severity, label: 'Negative feedback during session', message: 'No session decisions are linked to this draft.' };
  }

  const negative = input.decisions.filter((d) =>
    ['rejected', 'irrelevant', 'stale'].includes(d.decision) || isMissingContextDecision(d.decision),
  );
  if (negative.length === 0) {
    return { key, status: 'pass', severity, label: 'Negative feedback during session', message: 'No rejected, stale, irrelevant, or missing-context feedback during the session.' };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Negative feedback during session',
    message: `${negative.length} negative or missing-context decision${negative.length === 1 ? '' : 's'} were recorded — the underlying context may be unreliable.`,
    detail: negative.map((d) => d.decision).join(', '),
  };
}

function gateNoisyFeedback(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'noisy_feedback';
  const severity: GateSeverity = 'soft';
  if (input.decisions === undefined) {
    return { key, status: 'unknown', severity, label: 'Noisy context feedback', message: 'No session decisions are linked to this draft.' };
  }

  const noisy = input.decisions.filter((d) => d.decision === 'selected_but_noisy' || d.decision === 'too_much_adjacent_context');
  if (noisy.length === 0) {
    return { key, status: 'pass', severity, label: 'Noisy context feedback', message: 'The agent did not flag the context as noisy.' };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Noisy context feedback',
    message: `${noisy.length} noisy-context signal${noisy.length === 1 ? '' : 's'} — distillation may be premature.`,
    detail: noisy.map((d) => d.decision).join(', '),
  };
}

function gateSignalConfidence(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'signal_confidence';
  const severity: GateSeverity = 'hard';
  const signals = (input.draft.metadata as { learningSignals?: unknown }).learningSignals;
  if (!Array.isArray(signals) || signals.length === 0) {
    return {
      key,
      status: 'pass',
      severity,
      label: 'Learning signal confidence',
      message: 'No learning signals attached, so none can be low-confidence.',
    };
  }

  const lowConfidence = signals.filter((signal): signal is { confidence?: number; text?: string } => {
    return typeof signal === 'object' && signal !== null;
  }).filter((signal) => signal.confidence !== undefined && (signal.confidence as number) < 0.6);

  if (lowConfidence.length === 0) {
    return {
      key,
      status: 'pass',
      severity,
      label: 'Learning signal confidence',
      message: 'All learning signals are at or above the 0.6 confidence threshold.',
    };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Learning signal confidence',
    message: `Draft includes ${lowConfidence.length} low-confidence learning signal${lowConfidence.length === 1 ? '' : 's'} (below 0.6).`,
    detail: lowConfidence.map((s) => `"${truncate(s.text ?? '', 80)}" (${s.confidence})`).join('; '),
  };
}

function gateDuplicates(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'duplicates';
  const severity: GateSeverity = 'hard';
  if (input.draft.duplicateCandidates.length === 0) {
    return { key, status: 'pass', severity, label: 'Duplicate check', message: 'No similar approved memory already exists.' };
  }

  const top = input.draft.duplicateCandidates.slice(0, 3);
  return {
    key,
    status: 'fail',
    severity,
    label: 'Duplicate check',
    message: `${input.draft.duplicateCandidates.length} similar memor${input.draft.duplicateCandidates.length === 1 ? 'y' : 'ies'} already exist${input.draft.duplicateCandidates.length === 1 ? 's' : ''} — consider merging or supersession instead of approving as new.`,
    detail: top.map((c) => `"${truncate(c.title, 70)}"`).join('; '),
  };
}

function gateGroundedReferences(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'grounded_references';
  const severity: GateSeverity = 'hard';
  if (hasGroundedReference(input.draft.references)) {
    const concrete = input.draft.references.filter((r) => r.type !== 'conversation');
    return {
      key,
      status: 'pass',
      severity,
      label: 'Grounded references',
      message: `Draft cites ${concrete.length} concrete reference${concrete.length === 1 ? '' : 's'} (files, commits, URLs) — the lesson is verifiable.`,
      detail: concrete.slice(0, 3).map((r) => `${r.type}: ${truncate(r.uri, 60)}`).join('; '),
    };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Grounded references',
    message: 'Draft only cites conversation references — there is no verifiable source (file, URL, or commit) to ground the lesson.',
  };
}

function gateDistillationEvidence(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'distillation_evidence';
  const severity: GateSeverity = 'hard';
  const meta = (input.draft.metadata ?? {}) as Record<string, unknown>;
  if (meta.convention !== true) {
    return { key, status: 'pass', severity, label: 'Distillation evidence', message: 'Not a distilled convention — gate not applicable.' };
  }
  const steps = Array.isArray(meta.steps) ? meta.steps : [];
  const evidenceAtomIds = Array.isArray(meta.evidenceAtomIds) ? meta.evidenceAtomIds : [];
  const hasTrigger = !!meta.trigger && typeof meta.trigger === 'object'
    && Object.values(meta.trigger as Record<string, unknown>).some((v) => Array.isArray(v) && v.length > 0);
  if (steps.length > 0 && evidenceAtomIds.length >= 2 && hasTrigger) {
    return { key, status: 'pass', severity, label: 'Distillation evidence', message: `Convention generalizes ${evidenceAtomIds.length} atoms with ${steps.length} step(s) and a trigger.` };
  }
  return { key, status: 'fail', severity, label: 'Distillation evidence',
    message: `Convention needs ≥2 source atoms (got ${evidenceAtomIds.length}), non-empty steps (got ${steps.length}), and a trigger (${hasTrigger ? 'present' : 'missing'}).` };
}

function gateConcreteLabels(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'concrete_labels';
  const severity: GateSeverity = 'soft';
  const concrete = input.draft.suggestedLabels.filter((l) =>
    l.type === 'task_type' || l.type === 'file' || l.type === 'symbol' || l.type === 'error',
  );
  if (concrete.length > 0) {
    return {
      key,
      status: 'pass',
      severity,
      label: 'Concrete labels',
      message: `Draft is tagged with ${concrete.length} concrete label${concrete.length === 1 ? '' : 's'} (task, file, symbol, or error) — it will surface for relevant future tasks.`,
      detail: concrete.slice(0, 4).map((l) => `${l.type}: ${l.value}`).join('; '),
    };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Concrete labels',
    message: 'Draft lacks concrete labels (task type, file, symbol, or error). It may not surface for the right future tasks.',
  };
}

function gateDraftMaturity(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'draft_maturity';
  const severity: GateSeverity = 'soft';
  const summaryOk = input.draft.summary.length >= 32;
  const contentOk = input.draft.content.length >= 100;
  if (summaryOk && contentOk) {
    return {
      key,
      status: 'pass',
      severity,
      label: 'Draft is substantive',
      message: 'Summary and content are long enough to be useful when surfaced later.',
    };
  }

  const missing: string[] = [];
  if (!summaryOk) missing.push(`summary is ${input.draft.summary.length} chars (need ≥32)`);
  if (!contentOk) missing.push(`content is ${input.draft.content.length} chars (need ≥100)`);
  return {
    key,
    status: 'fail',
    severity,
    label: 'Draft is substantive',
    message: 'Draft is short and may not give a future reader enough context.',
    detail: missing.join('; '),
  };
}

/**
 * Phase 6b — surface the local-heuristic write-gate decision (Mem0 pattern,
 * no LLM) as a synthetic gate. The decision is computed at draft creation
 * and stored in `draft.metadata.writeGate`; this gate just reads it.
 *
 * Status mapping:
 * - decision='ADD' → pass (new memory is the right move)
 * - decision='NOOP' → fail (existing memory already covers this)
 * - decision='UPDATE' → fail (propose merge instead of new entry)
 * - decision='DELETE' → fail (propose superseding an existing memory)
 * - decision missing → unknown (no candidates were inspected; gate is not load-bearing)
 *
 * Hard severity: NOOP/UPDATE/DELETE block auto-approval, matching the
 * duplicates / grounded_references / signal_confidence gates.
 */
function gateWriteGate(input: EvaluateGatesInput): GateResult {
  const key: GateKey = 'write_gate';
  const severity: GateSeverity = 'hard';
  const writeGate = readWriteGateMetadata(input.draft.metadata);
  if (!writeGate) {
    // Backwards-compat: drafts created before Phase 6b have no writeGate
    // metadata. Treat the absence as a pass-with-note so older drafts are
    // not regressed into needs-review when the rest of the gates green.
    return {
      key,
      status: 'pass',
      severity,
      label: 'Memory write gate',
      message: 'No write-gate signal recorded on this draft (pre-Phase-6b draft or empty duplicate pool).',
    };
  }

  if (writeGate.decision === 'ADD') {
    return {
      key,
      status: 'pass',
      severity,
      label: 'Memory write gate',
      message: 'Draft is sufficiently distinct from existing memories — write-gate recommends adding a new entry.',
      detail: writeGate.reason,
    };
  }

  return {
    key,
    status: 'fail',
    severity,
    label: 'Memory write gate',
    message: writeGateFailMessage(writeGate.decision),
    detail: writeGate.reason,
  };
}

function writeGateFailMessage(decision: WriteGateMetadataDecision): string {
  switch (decision) {
    case 'NOOP':
      return 'Write-gate recommends NOOP — an existing memory already covers this lesson.';
    case 'UPDATE':
      return 'Write-gate recommends UPDATE — propose merging the new facts into the closest existing memory.';
    case 'DELETE':
      return 'Write-gate recommends DELETE — propose superseding the conflicting existing memory.';
    default:
      return 'Write-gate flagged this draft for review.';
  }
}

type WriteGateMetadataDecision = 'ADD' | 'UPDATE' | 'NOOP' | 'DELETE';

interface WriteGateMetadata {
  decision: WriteGateMetadataDecision;
  reason: string;
  closestKnowledgeId?: string;
}

function readWriteGateMetadata(metadata: Record<string, unknown>): WriteGateMetadata | undefined {
  const raw = metadata.writeGate;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const decision = record.decision;
  if (decision !== 'ADD' && decision !== 'UPDATE' && decision !== 'NOOP' && decision !== 'DELETE') {
    return undefined;
  }
  const reason = typeof record.reason === 'string' ? record.reason : `Write-gate decision: ${decision}.`;
  const closestKnowledgeId = typeof record.closestKnowledgeId === 'string' ? record.closestKnowledgeId : undefined;
  return { decision, reason, closestKnowledgeId };
}

export function aggregateRecommendation(
  gates: GateResult[],
  options: { draftId: string },
): DraftRecommendation {
  const pros: RecommendationPoint[] = [];
  const cons: RecommendationPoint[] = [];
  const blockers: RecommendationPoint[] = [];
  const unknowns: RecommendationPoint[] = [];

  for (const gate of gates) {
    const point: RecommendationPoint = { key: gate.key, label: gate.label, detail: gate.message };
    if (gate.status === 'pass') {
      pros.push(point);
    } else if (gate.status === 'unknown') {
      unknowns.push(point);
    } else if (gate.severity === 'hard') {
      blockers.push(point);
    } else {
      cons.push(point);
    }
  }

  const allEvaluable = gates.every((g) => g.status !== 'unknown');
  const allPass = gates.every((g) => g.status === 'pass');
  const canAutoApprove = allEvaluable && allPass;

  let verdict: RecommendationVerdict;
  let confidence: RecommendationConfidence;
  let oneLineRationale: string;

  if (blockers.length > 0) {
    verdict = 'reject';
    confidence = unknowns.length === 0 ? 'high' : 'medium';
    oneLineRationale = blockers.length === 1
      ? `Likely reject — one blocker: ${blockers[0].label.toLowerCase()}.`
      : `Likely reject — ${blockers.length} blockers (${blockers.map((b) => b.label.toLowerCase()).join(', ')}).`;
  } else if (cons.length === 0 && allEvaluable) {
    verdict = 'approve';
    confidence = 'high';
    oneLineRationale = 'Looks safe to approve — every quality check passed.';
  } else if (cons.length === 0 && unknowns.length > 0) {
    verdict = 'approve';
    confidence = 'medium';
    oneLineRationale = 'Looks safe to approve, but some quality checks could not be evaluated.';
  } else if (cons.length <= 2) {
    verdict = 'needs_changes';
    confidence = 'medium';
    oneLineRationale = cons.length === 1
      ? `Approve after addressing: ${cons[0].label.toLowerCase()}.`
      : `Approve after addressing: ${cons.map((c) => c.label.toLowerCase()).join(', ')}.`;
  } else {
    verdict = 'needs_changes';
    confidence = 'low';
    oneLineRationale = `${cons.length} quality concerns — needs review and edits before approval.`;
  }

  return {
    draftId: options.draftId,
    verdict,
    confidence,
    oneLineRationale,
    pros,
    cons,
    blockers,
    unknowns,
    gates,
    canAutoApprove,
  };
}

export async function recommendDraft(
  store: KnowledgeStore,
  draftId: string,
): Promise<DraftRecommendation | undefined> {
  const draft = await store.getReflectionDraft(draftId);
  if (!draft) {
    return undefined;
  }

  const { session, decisions, selectedPack } = await loadSessionContext(store, draft);
  const compliance = extractCompliance(session);
  const mode = extractLearningMode(draft);
  const outcome = session?.outcome;

  const gates = evaluateGates({ draft, mode, outcome, compliance, decisions, selectedPack });
  return aggregateRecommendation(gates, { draftId: draft.id });
}

async function loadSessionContext(
  store: KnowledgeStore,
  draft: ReflectionDraft,
): Promise<{ session?: AgentSession; decisions?: AgentContextDecision[]; selectedPack?: ContextPack }> {
  const sessionId = stringFromMetadata(draft.metadata, 'agentSessionId');
  const session = sessionId ? await store.getAgentSession(sessionId) : undefined;
  const decisions = sessionId
    ? await store.listAgentContextDecisions({ sessionId, limit: 100 })
    : undefined;
  const contextPackId = stringFromMetadata(draft.metadata, 'contextPackId') ?? session?.initialContextPackId;
  const selectedPack = contextPackId ? await store.getContextPack(contextPackId) : undefined;
  return { session, decisions, selectedPack };
}

function extractCompliance(session: AgentSession | undefined): AgentContextCompliance | undefined {
  const compliance = session?.metadata?.contextCompliance;
  if (compliance && typeof compliance === 'object' && 'status' in compliance) {
    return compliance as AgentContextCompliance;
  }
  return undefined;
}

function extractLearningMode(draft: ReflectionDraft): LearningMode | undefined {
  const mode = stringFromMetadata(draft.metadata, 'learningMode');
  if (mode === 'auto' || mode === 'draft_only' || mode === 'off') {
    return mode;
  }
  return undefined;
}

function stringFromMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function hasGroundedReference(references: ReferenceInput[]): boolean {
  return references.some((reference) => reference.type !== 'conversation');
}

function isMissingContextDecision(decision: string): boolean {
  return decision === 'missing_context'
    || decision === 'missing_orientation'
    || decision === 'missing_current_handoff'
    || decision === 'missing_verification_commands';
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export const __HARD_GATES = HARD_GATES;
