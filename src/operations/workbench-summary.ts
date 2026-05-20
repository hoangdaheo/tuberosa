import type { AppConfig } from '../config.js';
import type { ErrorLogInsightService } from '../error-log/insights.js';
import type {
  AgentSession,
  CollectErrorLogsOptions,
  ContextQualityReport,
  KnowledgeConflict,
  KnowledgeGap,
  LearningProposal,
  ReflectionDraft,
  StoredKnowledge,
  WorkbenchRecommendedAction,
  WorkbenchSummary,
  WorkbenchSummaryInput,
} from '../types.js';
import type { OperationsService } from './service.js';

const COUNT_LIMIT = 100;

export interface WorkbenchSummaryServices {
  config: Pick<AppConfig, 'store' | 'cache' | 'modelProvider' | 'backupDir'>;
  operations: Pick<
    OperationsService,
    | 'getBackupStatus'
    | 'listAgentSessions'
    | 'collectContextQualityFeedback'
    | 'listReflectionDrafts'
    | 'listKnowledgeGaps'
    | 'listLearningProposals'
    | 'listKnowledgeConflicts'
    | 'listKnowledge'
  >;
  errorLogInsights: Pick<ErrorLogInsightService, 'collect'>;
}

export async function buildWorkbenchSummary(
  services: WorkbenchSummaryServices,
  input: WorkbenchSummaryInput,
): Promise<WorkbenchSummary> {
  const filters = {
    project: input.project,
    limit: clampLimit(input.limit),
  };
  const project = filters.project;
  const listLimit = Math.max(filters.limit, COUNT_LIMIT);

  const [
    backupStatus,
    sessionCandidates,
    contextQuality,
    pendingDraftCandidates,
    openGapCandidates,
    openProposalCandidates,
    openConflictCandidates,
    autoMemoryCandidates,
    riskyAutoMemoryCandidates,
    openErrorLogs,
  ] = await Promise.all([
    services.operations.getBackupStatus(),
    services.operations.listAgentSessions({ project, limit: listLimit }),
    services.operations.collectContextQualityFeedback({ project, limit: filters.limit }),
    services.operations.listReflectionDrafts({ project, status: 'pending', limit: listLimit }),
    services.operations.listKnowledgeGaps({ project, status: 'open', limit: listLimit }),
    services.operations.listLearningProposals({ project, status: 'open', limit: listLimit }),
    services.operations.listKnowledgeConflicts({ project, status: 'open', limit: listLimit }),
    services.operations.listKnowledge({ project, review: 'auto_memory', limit: listLimit }),
    services.operations.listKnowledge({ project, review: 'risky_auto_memory', limit: listLimit }),
    services.errorLogInsights.collect(openErrorLogOptions(project, filters.limit)),
  ]);

  const recentSessions = sessionCandidates.slice(0, filters.limit);
  const pendingDrafts = pendingDraftCandidates.slice(0, filters.limit);
  const openGaps = openGapCandidates.slice(0, filters.limit);
  const openProposals = openProposalCandidates.slice(0, filters.limit);
  const openConflicts = openConflictCandidates.slice(0, filters.limit);
  const riskyAutoMemories = riskyAutoMemoryCandidates.slice(0, filters.limit);
  const activeSessions = sessionCandidates.filter((session) => session.status === 'active').length;
  const counts = {
    recentSessions: sessionCandidates.length,
    activeSessions,
    pendingDrafts: pendingDraftCandidates.length,
    contextQualityRecords: contextQuality.records.length,
    contextQualityMatched: contextQuality.totalMatched,
    openGaps: openGapCandidates.length,
    openProposals: openProposalCandidates.length,
    openConflicts: openConflictCandidates.length,
    autoMemories: autoMemoryCandidates.length,
    riskyAutoMemories: riskyAutoMemoryCandidates.length,
    openErrorLogs: openErrorLogs.totalMatched,
    backupCount: backupStatus.backupCount,
  };

  return {
    generatedAt: new Date().toISOString(),
    filters,
    health: {
      ok: true,
      service: 'tuberosa',
      store: services.config.store,
      durability: services.config.store === 'postgres' ? 'persistent' : 'ephemeral',
      cache: services.config.cache,
      modelProvider: services.config.modelProvider,
      backupDir: services.config.backupDir,
      backupStatus,
    },
    counts,
    recentSessions,
    contextQuality,
    pendingDrafts,
    openGaps,
    openProposals,
    openConflicts,
    riskyAutoMemories,
    openErrorLogs,
    recommendedActions: recommendedActions({
      counts,
      contextQuality,
      recentSessions,
      pendingDrafts,
      openGaps,
      openProposals,
      openConflicts,
      riskyAutoMemories,
      project,
    }),
  };
}

function openErrorLogOptions(project: string | undefined, limit: number): CollectErrorLogsOptions {
  return {
    project,
    statuses: ['open', 'triaged'],
    limit,
    offset: 0,
  };
}

function recommendedActions(input: {
  counts: WorkbenchSummary['counts'];
  contextQuality: ContextQualityReport;
  recentSessions: AgentSession[];
  pendingDrafts: ReflectionDraft[];
  openGaps: KnowledgeGap[];
  openProposals: LearningProposal[];
  openConflicts: KnowledgeConflict[];
  riskyAutoMemories: StoredKnowledge[];
  project?: string;
}): WorkbenchRecommendedAction[] {
  const actions: WorkbenchRecommendedAction[] = [];
  const projectQuery = input.project ? { project: input.project } : {};

  if (input.contextQuality.totalMatched > 0) {
    actions.push({
      priority: 1,
      target: 'context_quality',
      label: 'Review context-quality feedback',
      count: input.contextQuality.totalMatched,
      href: endpointWithQuery('/operations/context-quality', { ...projectQuery, limit: input.contextQuality.filters.limit }),
      reason: 'Noisy or missing context feedback directly affects startup trust.',
    });
  }

  if (input.pendingDrafts.length > 0) {
    actions.push({
      priority: 2,
      target: 'pending_drafts',
      label: 'Review pending reflection drafts',
      count: input.counts.pendingDrafts,
      href: endpointWithQuery('/reflection-drafts', { ...projectQuery, status: 'pending' }),
      reason: 'Unreviewed drafts stay out of retrieval until a reviewer decides.',
    });
  }

  if (input.riskyAutoMemories.length > 0) {
    actions.push({
      priority: 2,
      target: 'risky_auto_memories',
      label: 'Audit risky auto-approved memories',
      count: input.counts.riskyAutoMemories,
      href: endpointWithQuery('/knowledge', { ...projectQuery, review: 'risky_auto_memory' }),
      reason: 'Strict auto-learning stays enabled, but weak or disputed auto memories need visible review.',
    });
  }

  if (input.openConflicts.length > 0) {
    actions.push({
      priority: 3,
      target: 'knowledge_conflicts',
      label: 'Resolve open knowledge conflicts',
      count: input.counts.openConflicts,
      href: endpointWithQuery('/operations/conflicts', { ...projectQuery, status: 'open' }),
      reason: 'Conflicting guidance can make future context packs unreliable.',
    });
  }

  if (input.openGaps.length > 0) {
    actions.push({
      priority: 3,
      target: 'knowledge_gaps',
      label: 'Triage open knowledge gaps',
      count: input.counts.openGaps,
      href: endpointWithQuery('/operations/knowledge-gaps', { ...projectQuery, status: 'open' }),
      reason: 'Open gaps mark evidence agents could not find.',
    });
  }

  if (input.openProposals.length > 0) {
    actions.push({
      priority: 3,
      target: 'learning_proposals',
      label: 'Review open learning proposals',
      count: input.counts.openProposals,
      href: endpointWithQuery('/operations/learning-proposals', { ...projectQuery, status: 'open' }),
      reason: 'Learning proposals are the explicit path for label, relation, supersession, and cleanup changes.',
    });
  }

  if (input.counts.openErrorLogs > 0) {
    actions.push({
      priority: 4,
      target: 'error_logs',
      label: 'Review error-log learning candidates',
      count: input.counts.openErrorLogs,
      href: endpointWithQuery('/operations/error-logs/collection', {
        ...projectQuery,
        statuses: 'open,triaged',
      }),
      reason: 'Open incidents can become reviewed lessons after a real fix.',
    });
  }

  if (input.counts.activeSessions > 0) {
    actions.push({
      priority: 4,
      target: 'agent_sessions',
      label: 'Finish active sessions or record context decisions',
      count: input.counts.activeSessions,
      href: endpointWithQuery('/agent-sessions', { ...projectQuery, status: 'active' }),
      reason: 'Finished sessions with decisions provide the best audit trail for future agents.',
    });
  }

  if (actions.length === 0) {
    actions.push({
      priority: 5,
      target: 'none',
      label: 'No urgent review queues',
      count: 0,
      reason: 'The current filters did not surface context-quality, memory, conflict, session, or error-log work.',
    });
  }

  return actions.sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label));
}

function endpointWithQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') {
      query.set(key, String(value));
    }
  }

  const serialized = query.toString();
  return serialized ? `${path}?${serialized}` : path;
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}
