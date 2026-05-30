import type { AppServices } from '../app.js';
import { NotFoundError, toAppError, ValidationError, type AppError } from '../errors.js';
import { shouldAutoCapture } from '../error-log/auto-capture.js';
import { computeAtomGateStats } from '../operations/atom-gate-stats.js';
import { computeAtomGraphDensity } from '../operations/atom-graph-density.js';
import { predictImpact } from '../retrieval/impact-predictor.js';
import { getRetrievalPolicy } from '../retrieval/policy.js';
import { createUserStyleAtom } from '../user-style/store-helpers.js';
import { SourceSyncService } from '../source-sync/service.js';
import { AtlasService } from '../atlas/service.js';
import { tools } from './tool-definitions.js';
import { getPrompt, prompts } from './prompts.js';
import {
  readProtocolVersion,
  readRequiredMcpString,
  readOptionalMcpString,
  readMcpStringArray,
  readToolName,
  readToolArguments,
  readString,
  readStringArray,
  toolJson,
  resourceJson,
  type JsonRpcRequest,
} from './helpers.js';
import type { ContextFitStatus, ContextPack } from '../types.js';
import {
  expectRecord,
  validateAppendAgentSessionNoteInput,
  validateCaptureAgentLearningSignalInput,
  validateCollectErrorLogsInput,
  validateContextQualityReportInput,
  validateContextPackIdArguments,
  validateContextSearchInput,
  validateCreateErrorLogReflectionDraftInput,
  validateFeedbackInput,
  validateFinishAgentSessionInput,
  validateErrorLogIdArguments,
  validateErrorLogInput,
  validateErrorLogListInput,
  validateErrorLogPatchInput,
  validateMaintenanceApplyInput,
  validateMaintenanceProposeInput,
  validateRecordAgentContextDecisionInput,
  validateReflectionDraftIdArguments,
  validateReflectionDraftInput,
  validateReflectionDraftListInput,
  validateStartAgentSessionInput,
  validateReflectionDraftReviewInput,
  validateResolveErrorLogInput,
} from '../validation.js';

export async function handleMcpRequest(services: AppServices, request: JsonRpcRequest): Promise<unknown> {
  try {
    switch (request.method) {
      case 'initialize':
        return {
          protocolVersion: readProtocolVersion(request.params),
          capabilities: {
            tools: { listChanged: false },
            resources: {},
            prompts: {},
          },
          serverInfo: {
            name: 'tuberosa',
            version: '0.1.0',
          },
        };

      case 'ping':
        return {};

      case 'tools/list':
        return { tools: tools() };

      case 'tools/call':
        return await callTool(services, expectRecord(request.params ?? {}, 'tools/call params'));

      case 'resources/list':
        return { resources: [] };

      case 'resources/templates/list':
        return {
          resourceTemplates: [
            {
              uriTemplate: 'tuberosa://packs/{id}',
              name: 'Context pack',
              description: 'A proposed or selected Tuberosa context pack.',
              mimeType: 'application/json',
            },
            {
              uriTemplate: 'tuberosa://knowledge/{id}',
              name: 'Knowledge item',
              description: 'A stored Tuberosa knowledge item.',
              mimeType: 'application/json',
            },
            {
              uriTemplate: 'tuberosa://error-logs/{id}',
              name: 'Error log',
              description: 'A filesystem-backed Tuberosa error incident.',
              mimeType: 'application/json',
            },
            {
              uriTemplate: 'tuberosa://error-logs/{id}/markdown',
              name: 'Error log markdown',
              description: 'Human-readable Markdown for a filesystem-backed Tuberosa error incident.',
              mimeType: 'text/markdown',
            },
            {
              uriTemplate: 'tuberosa://atlas/{project}/{file}',
              name: 'Project atlas file',
              description: 'A synthesized project atlas file (project-map.md, flows.md, commands.md, risks.md, open-gaps.md).',
              mimeType: 'text/markdown',
            },
          ],
        };

      case 'resources/read':
        return await readResource(services, expectRecord(request.params ?? {}, 'resources/read params'));

      case 'prompts/list':
        return { prompts: prompts() };

      case 'prompts/get':
        return getPrompt(expectRecord(request.params ?? {}, 'prompts/get params'));

      default:
        throw new NotFoundError(`Unsupported MCP method: ${request.method}`);
    }
  } catch (error) {
    await maybeCaptureMcpError(services, request, error);
    throw error;
  }
}

async function callTool(services: AppServices, params: Record<string, unknown>) {
  const name = readRequiredMcpString(params.name, 'tools/call params.name');
  const args = expectRecord(params.arguments ?? {}, 'tools/call params.arguments');

  switch (name) {
    case 'tuberosa_search_context': {
      const input = validateContextSearchInput(args);
      const pack = await services.retrieval.searchContext(input);
      services.operations.requestPhysicalMirror('context-searched');
      return toolJson(contextPackShortlist(pack, { includeDeepContext: input.includeDeepContext }));
    }

    case 'tuberosa_get_context_pack': {
      const { contextPackId: id } = validateContextPackIdArguments(args);
      const pack = await services.retrieval.getContextPack(id);
      if (!pack) {
        throw new NotFoundError(`Context pack not found: ${id}`);
      }
      return toolJson(pack);
    }

    case 'tuberosa_reflect': {
      const draft = await services.reflection.createDraft(validateReflectionDraftInput(args));
      services.operations.requestPhysicalMirror('reflection-created');
      return toolJson({
        ...draft,
        instruction: 'This reflection is pending review. Approve it before it becomes searchable memory.',
      });
    }

    case 'tuberosa_list_reflection_drafts': {
      const drafts = await services.operations.listReflectionDrafts(validateReflectionDraftListInput(args));
      return toolJson({
        drafts,
        instruction: drafts.length > 0
          ? 'Review a draft with tuberosa_get_reflection_draft, then call tuberosa_review_reflection_draft with approve, reject, or needs_changes.'
          : 'No matching reflection drafts found.',
      });
    }

    case 'tuberosa_get_reflection_draft': {
      const { id } = validateReflectionDraftIdArguments(args);
      const draft = await services.operations.getReflectionDraft(id);
      if (!draft) {
        throw new NotFoundError(`Reflection draft not found: ${id}`);
      }

      return toolJson({
        draft,
        instruction: 'Evaluate accuracy, usefulness, scope, privacySafety, labels, references, and duplicateRisk before recording a decision.',
      });
    }

    case 'tuberosa_review_reflection_draft': {
      const draft = await services.reflection.reviewDraft(validateReflectionDraftReviewInput(args));
      if (!draft) {
        throw new NotFoundError(`Reflection draft not found: ${String(args.id ?? args.reflectionDraftId ?? '')}`);
      }

      services.operations.requestWriteThroughBackup('reflection-reviewed');
      services.operations.requestPhysicalMirror('reflection-reviewed');
      return toolJson({
        draft,
        instruction: reflectionReviewInstruction(draft.status),
      });
    }

    case 'tuberosa_feedback_context': {
      const result = await services.retrieval.recordFeedback(validateFeedbackInput(args));
      services.operations.requestPhysicalMirror('context-feedback-recorded');
      return toolJson(result);
    }

    case 'tuberosa_collect_context_quality_feedback': {
      const report = await services.operations.collectContextQualityFeedback(validateContextQualityReportInput(args));
      return toolJson({
        report,
        instruction: report.records.length > 0
          ? 'Review linked gaps, proposals, and adjacent item summaries before changing labels, relations, or ranking.'
          : 'No matching context-quality feedback found.',
      });
    }

    case 'tuberosa_record_error_log': {
      const log = await services.errorLogs.recordLog(validateErrorLogInput(args));
      return toolJson({
        log,
        instruction: 'Error log saved to the physical Tuberosa error-log journal. Link a reflection draft after the fix is durable.',
      });
    }

    case 'tuberosa_list_error_logs': {
      const logs = await services.errorLogs.listLogs(validateErrorLogListInput(args));
      return toolJson({
        logs,
        instruction: logs.length > 0
          ? 'Inspect a log with tuberosa_get_error_log before fixing or linking a reflection.'
          : 'No matching error logs found.',
      });
    }

    case 'tuberosa_collect_error_logs': {
      const collection = await services.errorLogInsights.collect(validateCollectErrorLogsInput(args));
      return toolJson({
        collection,
        instruction: collection.returned > 0
          ? 'Use the agentBrief and compact summaries first. Inspect raw incidents only when needed, then create a reflection draft for durable lessons.'
          : 'No matching error logs found.',
      });
    }

    case 'tuberosa_create_error_log_reflection_draft': {
      const result = await services.errorLogInsights.createReflectionDraft(
        validateCreateErrorLogReflectionDraftInput(args),
      );
      services.operations.requestPhysicalMirror('error-log-reflection-created');
      return toolJson({
        ...result,
        instruction: 'Reflection draft created from selected error logs. Review and approve it before it becomes searchable memory.',
      });
    }

    case 'tuberosa_get_error_log': {
      const { id } = validateErrorLogIdArguments(args);
      const log = await services.errorLogs.getLog(id);
      if (!log) {
        throw new NotFoundError(`Error log not found: ${id}`);
      }
      return toolJson({
        log,
        instruction: 'Use this incident as debugging context. Do not turn raw logs into memory; create a reviewed reflection after the fix.',
      });
    }

    case 'tuberosa_update_error_log': {
      const { id } = validateErrorLogIdArguments(args);
      const log = await services.errorLogs.updateLog(id, validateErrorLogPatchInput(args));
      if (!log) {
        throw new NotFoundError(`Error log not found: ${id}`);
      }
      return toolJson({
        log,
        instruction: log.reflectionDraftId
          ? 'Error log updated and linked to a reflection draft.'
          : 'Error log updated. Link a reviewed reflection draft when the durable lesson is ready.',
      });
    }

    case 'tuberosa_resolve_error_log': {
      const result = await services.errorLogInsights.resolve(validateResolveErrorLogInput(args));
      if (!result) {
        throw new NotFoundError(`Error log not found: ${String(args.id ?? args.errorLogId ?? '')}`);
      }
      return toolJson(result);
    }

    case 'tuberosa_start_session': {
      const input = validateStartAgentSessionInput(args);
      const result = await services.agentSessions.startSession(input);
      services.operations.requestPhysicalMirror('agent-session-started');
      return toolJson({
        session: result.session,
        context: contextPackShortlist(result.contextPack, { includeDeepContext: input.includeDeepContext }),
        policy: result.policy,
      });
    }

    case 'tuberosa_record_context_decision': {
      const result = await services.agentSessions.recordContextDecision(validateRecordAgentContextDecisionInput(args));
      services.operations.requestPhysicalMirror('agent-context-decision-recorded');
      return toolJson({
        session: result.session,
        decision: result.decision,
        retry: result.retry ? contextPackShortlist(result.retry) : undefined,
        policy: result.policy,
      });
    }

    case 'tuberosa_finish_session': {
      const result = await services.agentSessions.finishSession(validateFinishAgentSessionInput(args));
      services.operations.requestPhysicalMirror('agent-session-finished');
      return toolJson(result);
    }

    case 'tuberosa_capture_learning_signal': {
      const result = await services.agentSessions.captureLearningSignal(validateCaptureAgentLearningSignalInput(args));
      services.operations.requestPhysicalMirror('agent-learning-signal-captured');
      return toolJson({
        ...result,
        instruction: 'Learning signal captured as session evidence. It can feed finish-session learning but is not trusted memory by itself.',
      });
    }

    case 'tuberosa_append_session_note': {
      const result = await services.agentSessions.appendSessionNote(validateAppendAgentSessionNoteInput(args));
      services.operations.requestPhysicalMirror('agent-session-note-appended');
      return toolJson({
        ...result,
        instruction: 'Note appended. Use this for post-finish corrections, optionally with a context-quality feedbackType.',
      });
    }

    case 'tuberosa_propose_maintenance': {
      const batch = await services.maintenance.propose(validateMaintenanceProposeInput(args));
      return toolJson({
        batch,
        instruction: batch.items.length > 0
          ? 'Review the proposed maintenance items. Apply with tuberosa_apply_maintenance using batchId plus approvedItemIds — never auto-applied.'
          : 'No pending maintenance was detected for the current filters.',
      });
    }

    case 'tuberosa_apply_maintenance': {
      const result = await services.maintenance.apply(validateMaintenanceApplyInput(args));
      services.operations.requestPhysicalMirror('maintenance-applied');
      return toolJson({
        result,
        instruction: result.appliedCount > 0
          ? 'Maintenance applied. Inspect results[] for per-item outcomes; reruns are idempotent.'
          : 'No maintenance items were applied. Confirm batchId or approvedItemIds and try again.',
      });
    }

    case 'tuberosa_atom_gate_stats': {
      const project = typeof args.project === 'string' ? args.project : undefined;
      const windowDays = typeof args.windowDays === 'number' ? args.windowDays : 7;
      const stats = await computeAtomGateStats(services.store, { project, windowDays });
      return toolJson(stats);
    }

    case 'tuberosa_atom_graph_density': {
      const project = readRequiredMcpString(args.project, 'tuberosa_atom_graph_density arguments.project');
      const density = await computeAtomGraphDensity(services.store, { project });
      return toolJson(density);
    }

    case 'tuberosa_predict_impact': {
      const project = readRequiredMcpString(args.project, 'tuberosa_predict_impact arguments.project');
      const files = readMcpStringArray(args.files, 'tuberosa_predict_impact arguments.files');
      const symbols = readMcpStringArray(args.symbols, 'tuberosa_predict_impact arguments.symbols');
      const depth = typeof args.depth === 'number' && Number.isFinite(args.depth) && args.depth >= 1
        ? Math.min(4, Math.floor(args.depth))
        : undefined;
      const policy = getRetrievalPolicy().graph;
      const prediction = await predictImpact(services.store, {
        project,
        files,
        symbols,
        policy,
        depth,
      });
      return toolJson(prediction);
    }

    case 'tuberosa_export_pack': {
      const project = readRequiredMcpString(args.project, 'tuberosa_export_pack arguments.project');
      const outRaw = readRequiredMcpString(args.out, 'tuberosa_export_pack arguments.out');
      const { assertSafeBundlePath } = await import('../security/safe-paths.js');
      const out = await assertSafeBundlePath(services.config.exportBaseDir, outRaw);
      const { exportPack } = await import('../export/exporter.js');
      const report = await exportPack(services.store, {
        project,
        out,
        includeChunks: args.includeChunks === undefined ? true : Boolean(args.includeChunks),
        includeArchived: Boolean(args.includeArchived),
      });
      return toolJson(report);
    }

    case 'tuberosa_import_pack': {
      const fromRaw = readRequiredMcpString(args.from, 'tuberosa_import_pack arguments.from');
      const project = typeof args.project === 'string' ? args.project : undefined;
      const { assertSafeBundlePath } = await import('../security/safe-paths.js');
      const from = await assertSafeBundlePath(services.config.importBaseDir, fromRaw);
      const { importPack } = await import('../export/importer.js');
      const report = await importPack(services.store, {
        from,
        project,
        dryRun: Boolean(args.dryRun),
        onConflict: args.onConflict === 'skip' ? 'skip' : 'review',
      });
      return toolJson(report);
    }

    case 'tuberosa_list_atom_import_conflicts': {
      const project = typeof args.project === 'string' ? args.project : undefined;
      const status = typeof args.status === 'string' ? args.status : 'open';
      const rows = await services.store.listAtomImportConflicts({ project, status, limit: 100 });
      return toolJson(rows);
    }

    case 'tuberosa_resolve_atom_import_conflict': {
      const id = readRequiredMcpString(args.id, 'tuberosa_resolve_atom_import_conflict arguments.id');
      const action = args.action;
      if (
        action !== 'keep_local'
        && action !== 'take_imported'
        && action !== 'merged'
        && action !== 'dismissed'
      ) {
        throw new ValidationError('action must be keep_local|take_imported|merged|dismissed');
      }
      const updated = await services.store.resolveAtomImportConflict(
        id,
        action,
        args.mergedSnapshot,
        typeof args.notes === 'string' ? args.notes : undefined,
      );
      if (!updated) throw new NotFoundError(`Atom import conflict not found: ${id}`);
      return toolJson(updated);
    }

    case 'tuberosa_resurrect_atom': {
      const atomId = readRequiredMcpString(args.atomId, 'tuberosa_resurrect_atom arguments.atomId');
      const atom = await services.store.updateAtom(atomId, {
        status: 'active',
        lastReusedAt: new Date().toISOString(),
      });
      if (!atom) {
        throw new NotFoundError(`Atom not found: ${atomId}`);
      }
      services.operations.requestPhysicalMirror('atom-resurrected');
      return toolJson({ atom, instruction: 'Atom moved back to active; it competes in retrieval again.' });
    }

    case 'tuberosa_record_user_style': {
      const userId = readOptionalMcpString(args.userId, 'tuberosa_record_user_style arguments.userId')
        ?? services.config.userId;
      if (!userId) {
        throw new ValidationError('userId required (set TUBEROSA_USER_ID or include in arguments).');
      }
      const claim = readRequiredMcpString(args.claim, 'tuberosa_record_user_style arguments.claim');
      const type = readRequiredMcpString(args.type, 'tuberosa_record_user_style arguments.type');
      if (!USER_STYLE_TYPES.includes(type as typeof USER_STYLE_TYPES[number])) {
        throw new ValidationError(`type must be one of: ${USER_STYLE_TYPES.join(', ')}`);
      }
      const priority = (readOptionalMcpString(args.priority, 'tuberosa_record_user_style arguments.priority')
        ?? 'coding_preference') as 'personal_workflow' | 'coding_preference';
      if (!['personal_workflow', 'coding_preference'].includes(priority)) {
        throw new ValidationError('priority must be personal_workflow or coding_preference');
      }
      const trigger = (args.trigger ?? {}) as Record<string, unknown>;
      const atom = await createUserStyleAtom(services.store, {
        userId,
        claim,
        type: type as 'convention' | 'gotcha' | 'decision' | 'fact',
        priority,
        trigger: trigger as never,
        evidence: Array.isArray(args.evidence) ? (args.evidence as never) : undefined,
        pitfalls: Array.isArray(args.pitfalls) ? (args.pitfalls as string[]) : undefined,
        sessionId: readOptionalMcpString(args.sessionId, 'tuberosa_record_user_style arguments.sessionId'),
      });
      services.operations.requestPhysicalMirror('user-style-recorded');
      return toolJson({
        atom,
        instruction: 'User-style atom recorded. It is cross-project and will surface for trigger matches on retrieval.',
      });
    }

    case 'tuberosa_list_user_style': {
      const userId = readOptionalMcpString(args.userId, 'tuberosa_list_user_style arguments.userId')
        ?? services.config.userId;
      if (!userId) {
        throw new ValidationError('userId required (set TUBEROSA_USER_ID or include in arguments).');
      }
      const atoms = await services.store.listAtoms({
        project: undefined,
        scope: 'user',
        userId,
        limit: 100,
      });
      return toolJson({
        atoms,
        instruction: atoms.length === 0
          ? 'No user-style atoms recorded yet. Use tuberosa_record_user_style to capture one.'
          : 'User-style atoms for the configured user. They are cross-project and never tied to a single repo.',
      });
    }

    case 'tuberosa_sync_sources': {
      const project = readRequiredMcpString(args.project, 'tuberosa_sync_sources arguments.project');
      const repoPath = readOptionalMcpString(args.path, 'tuberosa_sync_sources arguments.path')
        ?? services.config.defaultCwd
        ?? process.cwd();
      const service = new SourceSyncService({ store: services.store, ingestion: services.ingestion });
      if (args.apply === true) {
        const planId = readRequiredMcpString(args.planId, 'tuberosa_sync_sources arguments.planId');
        const result = await service.apply({ planId, allowDestructive: true });
        services.operations.requestPhysicalMirror('sources-synced');
        return toolJson({ applied: true, result });
      }
      const { planId, plan } = await service.sync({ project, repoPath, trigger: 'mcp' });
      return toolJson({
        planId,
        plan,
        instruction: plan.destructive
          ? 'This plan archives knowledge for deleted files. Surface the deletions to the user and only re-call with apply:true + planId after they confirm.'
          : 'Additive plan (no deletions). Re-call with apply:true + planId to apply.',
      });
    }

    case 'tuberosa_get_atlas': {
      const project = readRequiredMcpString(args.project, 'tuberosa_get_atlas arguments.project');
      const file = readOptionalMcpString(args.file, 'tuberosa_get_atlas arguments.file');
      const repoPath = services.config.defaultCwd ?? process.cwd();
      const atlas = new AtlasService(services.store, { atlasDir: services.config.atlasDir ?? '.tuberosa/atlas' });
      const result = await atlas.regenerate({
        project,
        repoPath,
        generatedAt: new Date().toISOString(),
        write: false,
      });
      const files = file ? result.contents.filter((c) => c.name === file) : result.contents;
      return toolJson({ inputHash: result.inputHash, files });
    }

    default:
      throw new ValidationError(`Unknown Tuberosa tool: ${name}`);
  }
}

const USER_STYLE_TYPES = ['convention', 'gotcha', 'decision', 'fact'] as const;

function contextPackShortlist(pack: ContextPack, options: { includeDeepContext?: boolean } = {}) {
  const deepContextReturned = shouldReturnDeepContext(pack, options.includeDeepContext);

  return {
    contextPackId: pack.id,
    confidence: pack.confidence,
    contextFit: pack.contextFit,
    orientation: pack.orientation,
    taskBrief: pack.taskBrief,
    actionableMissingSignals: pack.actionableMissingSignals,
    project: pack.project,
    classified: pack.classified,
    sections: pack.sections.map((section) => ({
      name: section.name,
      tokenEstimate: section.tokenEstimate,
      items: section.items.map((item) => ({
        knowledgeId: item.knowledgeId,
        title: item.title,
        itemType: item.itemType,
        project: item.project,
        score: item.finalScore,
        reasons: item.matchReasons,
        fitScore: item.fitScore,
        fitReasons: item.fitReasons,
        fitMissingSignals: item.fitMissingSignals,
        evidenceCategory: item.evidenceCategory,
        evidenceStrength: item.evidenceStrength,
        usefulnessReason: item.usefulnessReason,
        actionableMissingSignals: item.actionableMissingSignals,
        references: item.references,
      })),
    })),
    deepContextAvailable: Boolean(pack.deepContext),
    deepContextReturned,
    deepContext: pack.deepContext
      ? deepContextReturned
        ? pack.deepContext
        : {
          budget: pack.deepContext.budget,
          tokenEstimate: pack.deepContext.tokenEstimate,
          sections: pack.deepContext.sections.map((section) => ({
            name: section.name,
            tokenEstimate: section.tokenEstimate,
            itemCount: section.items.length,
          })),
        }
      : undefined,
    ...(pack.debug ? { debug: pack.debug } : {}),
    impactPrediction: pack.impactPrediction,
    instruction: composeSearchInstruction(
      searchInstruction(pack.contextFit?.fitStatus, deepContextReturned),
      pack.taskBrief?.followUpSearches,
      pack.impactPrediction,
    ),
  };
}

function composeSearchInstruction(
  base: string,
  followUpSearches: string[] | undefined,
  impactPrediction: ContextPack['impactPrediction'],
): string {
  // Plan A — long prompts can surface sub-tasks the agent should re-search
  // for as it reaches each step. Append a follow-up hint without dropping the
  // existing fit-status instruction.
  let composed = base;
  if (followUpSearches && followUpSearches.length > 0) {
    const note = `Detected ${followUpSearches.length} follow-up sub-task(s) (taskBrief.followUpSearches). Call tuberosa_search_context again with each sub-task as the prompt when you reach that step.`;
    composed = composed ? `${composed}\n${note}` : note;
  }
  // Concern C2 — hint the agent that the upcoming edit has a predicted blast
  // radius. Names only — for the full graph trace they call tuberosa_predict_impact.
  if (impactPrediction && impactPrediction.predictedAffected.length > 0) {
    const top = impactPrediction.predictedAffected.slice(0, 3).map((p) => p.target.value).join(', ');
    const more = impactPrediction.truncated ? ' …' : '';
    const impactNote = `May affect: ${top}${more}. Call tuberosa_predict_impact for the full list.`;
    composed = composed ? `${composed}\n${impactNote}` : impactNote;
  }
  return composed;
}

function shouldReturnDeepContext(pack: ContextPack, includeDeepContext: boolean | undefined): boolean {
  if (!includeDeepContext || !pack.deepContext) {
    return false;
  }

  return pack.contextFit?.fitStatus !== 'insufficient';
}

function searchInstruction(fitStatus: ContextFitStatus | undefined, deepContextReturned = false): string {
  if (fitStatus === 'insufficient') {
    return 'Context fit is insufficient. Ask a clarifying question or continue with fresh context instead of relying on this pack.';
  }

  if (fitStatus === 'needs_confirmation') {
    if (deepContextReturned) {
      return 'Context fit needs confirmation. Review the returned deep context before relying on it, then record a context decision.';
    }

    return 'Context fit needs confirmation. Review the shortlist and confirm it is appropriate before using the full pack.';
  }

  if (deepContextReturned) {
    return 'Use the returned deep context before working and record a selected context decision.';
  }

  return 'Review the shortlist. Call tuberosa_get_context_pack only after the user or agent confirms this pack is appropriate.';
}

function reflectionReviewInstruction(status: string): string {
  switch (status) {
    case 'approved':
      return 'Draft approved and ingested as searchable reflection memory.';
    case 'rejected':
      return 'Draft rejected and will not become searchable memory.';
    case 'needs_changes':
      return 'Draft marked as needing changes. Revise or recreate it before approval.';
    default:
      return 'Draft remains pending review.';
  }
}

async function readResource(services: AppServices, params: Record<string, unknown>) {
  const uri = String(params.uri ?? '');

  if (uri.startsWith('tuberosa://atlas/')) {
    const rest = uri.replace('tuberosa://atlas/', '');
    const slash = rest.lastIndexOf('/');
    if (slash <= 0) {
      throw new NotFoundError(`Atlas resource must be tuberosa://atlas/{project}/{file}: ${uri}`);
    }
    const project = rest.slice(0, slash);
    const file = rest.slice(slash + 1);
    const atlas = new AtlasService(services.store, { atlasDir: services.config.atlasDir ?? '.tuberosa/atlas' });
    const result = await atlas.regenerate({
      project,
      repoPath: services.config.defaultCwd ?? process.cwd(),
      generatedAt: new Date().toISOString(),
      write: false,
    });
    const match = result.contents.find((c) => c.name === file);
    if (!match) {
      throw new NotFoundError(`Atlas file not found: ${file}`);
    }
    return { contents: [{ uri, mimeType: 'text/markdown', text: match.content }] };
  }

  if (uri.startsWith('tuberosa://packs/')) {
    const id = uri.replace('tuberosa://packs/', '');
    const pack = await services.retrieval.getContextPack(id);
    if (!pack) {
      throw new NotFoundError(`Context pack not found: ${id}`);
    }

    return resourceJson(uri, pack);
  }

  if (uri.startsWith('tuberosa://knowledge/')) {
    const id = uri.replace('tuberosa://knowledge/', '');
    const knowledge = await services.store.getKnowledge(id);
    if (!knowledge) {
      throw new NotFoundError(`Knowledge item not found: ${id}`);
    }

    return resourceJson(uri, knowledge);
  }

  if (uri.startsWith('tuberosa://error-logs/') && uri.endsWith('/markdown')) {
    const id = uri.replace('tuberosa://error-logs/', '').replace('/markdown', '');
    const markdown = await services.errorLogs.readLogMarkdown(id);
    if (!markdown) {
      throw new NotFoundError(`Error log not found: ${id}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: markdown,
        },
      ],
    };
  }

  if (uri.startsWith('tuberosa://error-logs/')) {
    const id = uri.replace('tuberosa://error-logs/', '');
    const log = await services.errorLogs.getLog(id);
    if (!log) {
      throw new NotFoundError(`Error log not found: ${id}`);
    }

    return resourceJson(uri, log);
  }

  throw new ValidationError(`Unsupported resource URI: ${uri}`);
}

async function maybeCaptureMcpError(services: AppServices, request: JsonRpcRequest, error: unknown): Promise<void> {
  const appError = toAppError(error);
  if (!shouldAutoCapture(services, appError)) {
    return;
  }

  try {
    const args = readToolArguments(request);
    await services.errorLogs.recordLog({
      project: readString(args.project),
      category: categoryForAppError(appError, request),
      severity: appError.status >= 500 ? 'error' : 'warning',
      title: `MCP ${request.method}${readToolName(request) ? ` ${readToolName(request)}` : ''} failed`,
      summary: `${appError.code}: ${appError.message}`,
      message: appError.message,
      stack: appError.stack,
      toolName: readToolName(request),
      operation: request.method,
      cwd: readString(args.cwd),
      files: readStringArray(args.files),
      symbols: readStringArray(args.symbols),
      errors: readStringArray(args.errors),
      agentTool: 'mcp',
      sessionId: readString(args.sessionId),
      contextPackId: readString(args.contextPackId),
      metadata: {
        surface: 'mcp',
        code: appError.code,
        status: appError.status,
        method: request.method,
        requestId: request.id,
      },
    });
  } catch (captureError) {
    console.error('[error-log]', captureError instanceof Error ? captureError.message : String(captureError));
  }
}

function categoryForAppError(error: AppError, request: JsonRpcRequest) {
  const toolName = readToolName(request);
  if (toolName?.includes('retrieval') || toolName?.includes('context')) {
    return 'retrieval';
  }
  if (toolName?.includes('reflect')) {
    return 'reflection';
  }
  if (toolName?.includes('session')) {
    return 'agent_session';
  }
  switch (error.code) {
    case 'cache_error':
      return 'cache';
    case 'model_provider_error':
      return 'model_provider';
    case 'store_error':
      return 'database';
    default:
      return 'mcp';
  }
}
