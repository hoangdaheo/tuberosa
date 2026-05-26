import type {
  AgentSessionStartResult,
  ContextPack,
  ContextPackSection,
  ContextStackItemView,
  EvidenceGraphEdge,
  EvidenceGraphNode,
  EvidenceGraphTone,
  MissingSignalGroups,
  PipelineStageView,
  RankedCandidate,
  SessionNextActionView,
  SessionResultViewModel,
  SessionVerdictStatus,
} from '../types.js';

export function presentSessionResult(result: AgentSessionStartResult): SessionResultViewModel {
  const pack = result.contextPack;
  const missingSignals = groupMissingSignals(pack);
  const status = pack.contextFit?.fitStatus ?? 'unknown';

  return {
    sessionId: result.session.id,
    prompt: result.session.prompt,
    project: result.session.project,
    verdict: {
      status,
      headline: verdictHeadline(status, pack.contextFit?.fitScore),
      detail: verdictDetail(status, pack.contextFit?.fitReasons ?? []),
      score: pack.contextFit?.fitScore,
      policyAction: result.policy.action,
      policyInstruction: result.policy.instruction,
    },
    pipeline: pipelineStages(pack, status, missingSignals),
    graph: evidenceGraph(pack),
    contextStack: {
      essential: sectionItems(pack, 'essential'),
      supporting: sectionItems(pack, 'supporting'),
      optional: sectionItems(pack, 'optional'),
    },
    handoff: {
      title: pack.taskBrief?.goal ?? result.session.prompt,
      text: handoffText(result, missingSignals),
      commands: pack.orientation?.verificationCommands ?? [],
      files: pack.orientation?.recommendedFiles ?? [],
      warnings: flattenMissing(missingSignals),
    },
    missingSignals,
    nextActions: nextActions(status),
  };
}

function verdictHeadline(status: SessionVerdictStatus, score: number | undefined): string {
  const suffix = score === undefined ? '' : ` (${Math.round(score * 100)}%)`;
  if (status === 'ready') return `Context is ready${suffix}`;
  if (status === 'needs_confirmation') return `Context needs confirmation${suffix}`;
  if (status === 'insufficient') return `Context is insufficient${suffix}`;
  return 'No context verdict recorded';
}

function verdictDetail(status: SessionVerdictStatus, reasons: string[]): string {
  const reason = reasons.slice(0, 3).join(' · ');
  if (status === 'ready') return reason || 'Tuberosa found enough direct evidence for the agent to proceed.';
  if (status === 'needs_confirmation') return reason || 'Useful evidence exists, but the agent should confirm it before relying on it.';
  if (status === 'insufficient') return reason || 'Tuberosa needs more project knowledge or clearer task signals.';
  return 'The context pack did not include fit diagnostics.';
}

function pipelineStages(pack: ContextPack, status: SessionVerdictStatus, missing: MissingSignalGroups): PipelineStageView[] {
  const candidateCount = pack.sections.reduce((sum, section) => sum + section.items.length, 0);
  const hasMissing = flattenMissing(missing).length > 0;
  return [
    { key: 'prompt', label: 'Prompt', status: 'done', detail: pack.prompt },
    { key: 'classify', label: 'Classify', status: 'done', detail: pack.orientation?.inferredTask ?? pack.taskBrief?.goal ?? 'Task classified' },
    { key: 'retrieve', label: 'Retrieve', status: candidateCount > 0 ? 'done' : 'attention', detail: 'Knowledge candidates grouped by relevance.', count: candidateCount },
    { key: 'rank', label: 'Rank', status: candidateCount > 0 ? 'done' : 'attention', detail: 'Evidence is sorted into essential, supporting, and optional context.', count: candidateCount },
    { key: 'fit', label: 'Fit', status: status === 'ready' ? 'done' : 'attention', detail: pack.contextFit?.fitReasons?.[0] ?? 'Fit diagnostics unavailable.' },
    { key: 'decision', label: 'Decision', status: 'waiting', detail: 'Record whether this context helped.' },
    { key: 'memory', label: 'Memory', status: hasMissing ? 'attention' : 'waiting', detail: hasMissing ? 'Missing context can become review work.' : 'Finish the session to capture learning.' },
  ];
}

function evidenceGraph(pack: ContextPack): { nodes: EvidenceGraphNode[]; edges: EvidenceGraphEdge[] } {
  const nodes: EvidenceGraphNode[] = [
    { id: 'task', kind: 'task', label: 'Task', detail: pack.prompt, tone: 'accent' },
    { id: `pack-${pack.id}`, kind: 'pack', label: 'Context pack', detail: pack.contextFit?.fitStatus ?? pack.status, tone: toneForStatus(pack.contextFit?.fitStatus) },
  ];
  const edges: EvidenceGraphEdge[] = [
    { id: `task-pack-${pack.id}`, from: 'task', to: `pack-${pack.id}`, label: 'mapped into', tone: 'accent' },
  ];

  for (const section of pack.sections) {
    for (const item of section.items) {
      const knowledgeNodeId = `knowledge-${item.knowledgeId}`;
      nodes.push({
        id: knowledgeNodeId,
        kind: item.itemType === 'memory' ? 'memory' : 'knowledge',
        label: item.title,
        detail: item.summary,
        tone: toneForStrength(item.evidenceStrength),
      });
      edges.push({
        id: `${knowledgeNodeId}-pack`,
        from: `pack-${pack.id}`,
        to: knowledgeNodeId,
        label: section.name,
        tone: toneForStrength(item.evidenceStrength),
      });
      for (const ref of item.references ?? []) {
        const kind = ref.type === 'symbol' ? 'symbol' : 'file';
        const refNodeId = `${kind}-${ref.uri}`;
        if (!nodes.some((node) => node.id === refNodeId)) {
          nodes.push({ id: refNodeId, kind, label: ref.uri, tone: 'muted' });
        }
        edges.push({
          id: `${knowledgeNodeId}-${refNodeId}`,
          from: knowledgeNodeId,
          to: refNodeId,
          label: `references ${ref.type}`,
          tone: 'muted',
        });
      }
    }
  }

  return { nodes, edges };
}

function sectionItems(pack: ContextPack, sectionName: ContextPackSection['name']): ContextStackItemView[] {
  const section = pack.sections.find((entry) => entry.name === sectionName);
  return (section?.items ?? []).map(candidateItem);
}

function candidateItem(item: RankedCandidate): ContextStackItemView {
  return {
    knowledgeId: item.knowledgeId,
    title: item.title,
    summary: item.summary,
    itemType: item.itemType,
    evidenceStrength: item.evidenceStrength ?? 'unrated',
    evidenceCategory: evidenceCategoryLabel(item.evidenceCategory),
    score: item.finalScore,
    why: item.usefulnessReason ?? item.matchReasons?.join(' · '),
    references: item.references ?? [],
  };
}

function groupMissingSignals(pack: ContextPack): MissingSignalGroups {
  const orientationMissing = pack.orientation?.missingSignals;
  if (orientationMissing && !Array.isArray(orientationMissing)) {
    return {
      files: orientationMissing.files ?? [],
      symbols: orientationMissing.symbols ?? [],
      errors: orientationMissing.errors ?? [],
      docs: orientationMissing.docs ?? [],
      intent: orientationMissing.intent ?? [],
      other: orientationMissing.other ?? [],
    };
  }

  const out: MissingSignalGroups = { files: [], symbols: [], errors: [], docs: [], intent: [], other: [] };
  const raw = pack.contextFit?.missingSignals ?? [];
  for (const entry of raw) {
    const [kind, ...rest] = entry.split(':');
    const value = rest.join(':') || entry;
    if (kind === 'file') out.files.push(value);
    else if (kind === 'symbol') out.symbols.push(value);
    else if (kind === 'error') out.errors.push(value);
    else if (kind === 'doc') out.docs.push(value);
    else if (kind === 'intent') out.intent.push(value);
    else out.other.push(entry);
  }
  return out;
}

function flattenMissing(missing: MissingSignalGroups): string[] {
  return [...missing.files, ...missing.symbols, ...missing.errors, ...missing.docs, ...missing.intent, ...missing.other];
}

function handoffText(result: AgentSessionStartResult, missing: MissingSignalGroups): string {
  const pack = result.contextPack;
  const lines = [
    `Task: ${result.session.prompt}`,
    `Policy: ${result.policy.action} - ${result.policy.instruction}`,
  ];
  if (pack.taskBrief?.goal) lines.push(`Goal: ${pack.taskBrief.goal}`);
  const files = pack.orientation?.recommendedFiles ?? [];
  if (files.length > 0) {
    lines.push('Read first:');
    for (const file of files.slice(0, 8)) lines.push(`- ${file.path}: ${file.reason}`);
  }
  const commands = pack.orientation?.verificationCommands ?? [];
  if (commands.length > 0) {
    lines.push('Verify with:');
    for (const command of commands) lines.push(`- ${command}`);
  }
  const missingValues = flattenMissing(missing);
  if (missingValues.length > 0) {
    lines.push('Missing context:');
    for (const value of missingValues.slice(0, 8)) lines.push(`- ${value}`);
  }
  return lines.join('\n');
}

function nextActions(status: SessionVerdictStatus): SessionNextActionView[] {
  const needsMoreContext = status === 'insufficient' || status === 'needs_confirmation';
  return [
    { kind: 'record_decision', label: 'Record decision', tone: status === 'ready' ? 'good' : 'warn' },
    ...(needsMoreContext
      ? ([
          { kind: 'ingest_missing_context', label: 'Ingest missing context', tone: 'warn' },
          { kind: 'retry_same_task', label: 'Retry same task', tone: 'accent' },
        ] as SessionNextActionView[])
      : []),
    { kind: 'copy_handoff', label: 'Copy agent handoff', tone: 'accent' },
    { kind: 'finish_session', label: 'Finish session', tone: 'muted' },
  ];
}

function evidenceCategoryLabel(value: RankedCandidate['evidenceCategory']): string {
  if (value === 'directTaskEvidence') return 'Direct evidence';
  if (value === 'priorLessons') return 'Prior lesson';
  if (value === 'workflowGuidance') return 'Workflow guidance';
  if (value === 'adjacentContext') return 'Adjacent context';
  return 'Context';
}

function toneForStatus(status: SessionVerdictStatus | undefined): EvidenceGraphTone {
  if (status === 'ready') return 'good';
  if (status === 'needs_confirmation') return 'warn';
  if (status === 'insufficient') return 'bad';
  return 'muted';
}

function toneForStrength(strength: RankedCandidate['evidenceStrength']): EvidenceGraphTone {
  if (strength === 'strong') return 'good';
  if (strength === 'moderate') return 'warn';
  if (strength === 'weak') return 'bad';
  return 'muted';
}
