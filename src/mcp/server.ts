import type { AppServices } from '../app.js';
import { NotFoundError, toAppError, ValidationError, type AppError } from '../errors.js';
import type { ContextFitStatus, ContextPack } from '../types.js';
import {
  AGENT_LEARNING_MODES,
  AGENT_SESSION_OUTCOMES,
  CONTEXT_MODES,
  CONTEXT_QUALITY_FEEDBACK_TYPES,
  FEEDBACK_TYPES,
  KNOWLEDGE_ITEM_TYPES,
  REFLECTION_DRAFT_STATUSES,
  TASK_TYPES,
  TRIGGER_TYPES,
  expectRecord,
  validateAppendAgentSessionNoteInput,
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
  validateRecordAgentContextDecisionInput,
  validateReflectionDraftIdArguments,
  validateReflectionDraftInput,
  validateReflectionDraftListInput,
  validateStartAgentSessionInput,
  validateReflectionDraftReviewInput,
  validateResolveErrorLogInput,
} from '../validation.js';

interface JsonRpcRequest {
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

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

function readProtocolVersion(params: Record<string, unknown> | undefined): string {
  return typeof params?.protocolVersion === 'string' && params.protocolVersion.trim()
    ? params.protocolVersion
    : '2025-06-18';
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

    case 'tuberosa_append_session_note': {
      const result = await services.agentSessions.appendSessionNote(validateAppendAgentSessionNoteInput(args));
      services.operations.requestPhysicalMirror('agent-session-note-appended');
      return toolJson({
        ...result,
        instruction: 'Note appended. Use this for post-finish corrections, optionally with a context-quality feedbackType.',
      });
    }

    default:
      throw new ValidationError(`Unknown Tuberosa tool: ${name}`);
  }
}

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
    instruction: searchInstruction(pack.contextFit?.fitStatus, deepContextReturned),
  };
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

function getPrompt(params: Record<string, unknown>) {
  const name = String(params.name ?? '');
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  if (name === 'tuberosa_bootstrap_session') {
    return {
      description: 'Retrieve and confirm relevant Tuberosa context before starting work.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Before starting the task, call tuberosa_start_session with the user prompt as-is, then enrich it yourself with current project, cwd, files, symbols, errors, contextMode layered, and includeDeepContext true when known.',
              'Use returned deep context when deepContextReturned is true; otherwise inspect the shortlist and fetch the full pack only after confirming it is appropriate.',
              'Record selected, rejected, stale, irrelevant, or missing_context with tuberosa_record_context_decision before finishing the session.',
              'Finish with tuberosa_finish_session. Unless the user opts out, let automatic session learning extract the durable lesson; weak candidates stay reviewable and strong candidates can be approved automatically.',
              'If the context is rejected, record the decision and retry once. If it still misses, continue with fresh context only after recording missing_context or an explicit bypass reason.',
              args.prompt ? `User prompt: ${args.prompt}` : undefined,
            ].filter(Boolean).join('\n'),
          },
        },
      ],
    };
  }

  if (name === 'tuberosa_reflect_after_task') {
    return {
      description: 'Create a reviewable reflection draft after a useful learning event.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'If the task involved a complex success, recovered error, user correction, or non-trivial workflow, call tuberosa_reflect.',
              'Use a concise title, a normalized summary, the durable lesson, triggerType, project, labels, and references.',
              'Do not save secrets or raw private conversation that is not needed for future behavior.',
            ].join('\n'),
          },
        },
      ],
    };
  }

  if (name === 'tuberosa_review_pending_reflections') {
    return {
      description: 'Review pending reflection drafts before they become searchable memory.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Call tuberosa_list_reflection_drafts with status pending and the project when known.',
              'For each draft worth reviewing, call tuberosa_get_reflection_draft and evaluate accuracy, usefulness, scope, privacySafety, labels, references, and duplicateRisk.',
              'Record the decision with tuberosa_review_reflection_draft using approve, reject, or needs_changes plus a concise reviewerNote.',
              args.project ? `Project: ${args.project}` : undefined,
            ].filter(Boolean).join('\n'),
          },
        },
      ],
    };
  }

  if (name === 'tuberosa_capture_error_for_later') {
    return {
      description: 'Record an agent or Tuberosa development error in the physical error-log journal.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'When a command, MCP tool, HTTP call, or debugging path fails and the fix should happen later, call tuberosa_record_error_log.',
              'Include project, category, severity, title, summary, sanitized message/stack, cwd, command, files, symbols, errors, tags, and references when known.',
              'Do not save secrets or raw private conversation. After fixing, create a reflection draft for the durable lesson and update the error log with status fixed plus reflectionDraftId.',
              args.project ? `Project: ${args.project}` : undefined,
            ].filter(Boolean).join('\n'),
          },
        },
      ],
    };
  }

  if (name === 'tuberosa_review_error_logs') {
    return {
      description: 'Collect, inspect, and convert selected error logs into reviewed learning candidates.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Call tuberosa_collect_error_logs with project and focused filters when known.',
              'Use the returned agentBrief, rollups, clusters, and compact summaries before reading raw incidents.',
              'Inspect raw logs with tuberosa_get_error_log only for incidents that need debugging detail.',
              'When a durable lesson is clear, call tuberosa_create_error_log_reflection_draft with explicit errorLogIds.',
              'Do not treat raw logs as searchable memory until the reflection draft is reviewed and approved.',
              args.project ? `Project: ${args.project}` : undefined,
            ].filter(Boolean).join('\n'),
          },
        },
      ],
    };
  }

  if (name === 'tuberosa_fix_error_log') {
    return {
      description: 'Guide an agent through fixing and resolving a Tuberosa error-log incident.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              args.errorLogId
                ? `Start by calling tuberosa_get_error_log for errorLogId ${args.errorLogId}.`
                : 'Start by calling tuberosa_collect_error_logs with open/triaged statuses and focused project filters when known.',
              'Use tuberosa_search_context with the incident project, files, symbols, and errors before editing code.',
              'Inspect the relevant source, implement the smallest fix that addresses the root cause, and run the appropriate verification commands.',
              'If the fix creates a reusable lesson, call tuberosa_create_error_log_reflection_draft with explicit errorLogIds.',
              'Finish by calling tuberosa_resolve_error_log with rootCause, resolutionSummary, changedFiles, verificationCommands, and reflectionDraftId when available.',
              args.project ? `Project: ${args.project}` : undefined,
            ].filter(Boolean).join('\n'),
          },
        },
      ],
    };
  }

  throw new ValidationError(`Unknown prompt: ${name}`);
}

function readRequiredMcpString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${path} must be a non-empty string.`, [
      { path, message: `${path} must be a non-empty string.` },
    ]);
  }

  return value;
}

function tools() {
  return [
    {
      name: 'tuberosa_search_context',
      title: 'Search Tuberosa Context',
      description: 'Classify a user task and return a ranked context shortlist with provenance and confidence.',
      inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
          project: { type: 'string' },
          repoHint: { type: 'string' },
          cwd: { type: 'string' },
          taskType: {
            type: 'string',
            enum: [...TASK_TYPES],
            description: 'Canonical task type. If unsure, omit this field or use unknown.',
          },
          files: { type: 'array', items: { type: 'string' } },
          symbols: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
          tokenBudget: { type: 'number' },
          contextMode: { type: 'string', enum: [...CONTEXT_MODES] },
          deepContextBudget: { type: 'number' },
          includeDeepContext: { type: 'boolean' },
          rejectedKnowledgeIds: { type: 'array', items: { type: 'string' } },
          bypassCache: { type: 'boolean' },
          debug: { type: 'boolean' },
        },
      },
    },
    {
      name: 'tuberosa_get_context_pack',
      title: 'Get Tuberosa Context Pack',
      description: 'Read a selected context pack by id.',
      inputSchema: {
        type: 'object',
        required: ['contextPackId'],
        properties: {
          contextPackId: { type: 'string' },
        },
      },
    },
    {
      name: 'tuberosa_start_session',
      title: 'Start Tuberosa Agent Session',
      description: 'Create an agent session and return the initial context shortlist plus fit policy.',
      inputSchema: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
          project: { type: 'string' },
          repoHint: { type: 'string' },
          cwd: { type: 'string' },
          taskType: {
            type: 'string',
            enum: [...TASK_TYPES],
            description: 'Canonical task type. If unsure, omit this field or use unknown.',
          },
          files: { type: 'array', items: { type: 'string' } },
          symbols: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
          tokenBudget: { type: 'number' },
          contextMode: { type: 'string', enum: [...CONTEXT_MODES] },
          deepContextBudget: { type: 'number' },
          includeDeepContext: { type: 'boolean' },
          rejectedKnowledgeIds: { type: 'array', items: { type: 'string' } },
          bypassCache: { type: 'boolean' },
          debug: { type: 'boolean' },
          agentName: { type: 'string' },
          agentTool: { type: 'string' },
          metadata: { type: 'object' },
        },
      },
    },
    {
      name: 'tuberosa_record_context_decision',
      title: 'Record Tuberosa Session Context Decision',
      description: 'Record selected, rejected, stale, irrelevant, or missing context for an agent session.',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'feedbackType'],
        properties: {
          sessionId: { type: 'string' },
          contextPackId: { type: 'string' },
          feedbackType: { type: 'string', enum: [...FEEDBACK_TYPES] },
          reason: { type: 'string' },
          rejectedKnowledgeIds: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object' },
        },
      },
    },
    {
      name: 'tuberosa_finish_session',
      title: 'Finish Tuberosa Agent Session',
      description: 'Finish an agent session and create automatic learning unless disabled or replaced by an explicit reflection draft.',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'outcome'],
        properties: {
          sessionId: { type: 'string' },
          outcome: { type: 'string', enum: [...AGENT_SESSION_OUTCOMES] },
          summary: { type: 'string' },
          contextBypassReason: { type: 'string' },
          learningMode: { type: 'string', enum: [...AGENT_LEARNING_MODES] },
          metadata: { type: 'object' },
          reflectionDraft: {
            type: 'object',
            required: ['title', 'summary', 'content', 'triggerType'],
            properties: {
              project: { type: 'string' },
              title: { type: 'string' },
              summary: { type: 'string' },
              content: { type: 'string' },
              itemType: { type: 'string', enum: [...KNOWLEDGE_ITEM_TYPES] },
              triggerType: { type: 'string', enum: [...TRIGGER_TYPES] },
              labels: { type: 'array', items: { type: 'object' } },
              references: { type: 'array', items: { type: 'object' } },
              metadata: { type: 'object' },
            },
          },
        },
      },
    },
    {
      name: 'tuberosa_append_session_note',
      title: 'Append Tuberosa Agent Session Note',
      description: 'Append a post-finish note to an agent session. Optional feedbackType records context-quality feedback (selected_but_noisy, too_much_adjacent_context, missing_orientation, missing_current_handoff, missing_verification_commands) tied to the session for ranking and review.',
      inputSchema: {
        type: 'object',
        required: ['sessionId', 'note'],
        properties: {
          sessionId: { type: 'string' },
          note: { type: 'string' },
          author: { type: 'string' },
          feedbackType: { type: 'string', enum: [...FEEDBACK_TYPES] },
          contextPackId: { type: 'string' },
          reason: { type: 'string' },
          rejectedKnowledgeIds: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object' },
        },
      },
    },
    {
      name: 'tuberosa_reflect',
      title: 'Create Tuberosa Reflection Draft',
      description: 'Create a reviewable learning draft after a complex task, correction, error recovery, or workflow discovery.',
      inputSchema: {
        type: 'object',
        required: ['title', 'summary', 'content', 'triggerType'],
        properties: {
          project: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          content: { type: 'string' },
          itemType: { type: 'string', enum: [...KNOWLEDGE_ITEM_TYPES] },
          triggerType: { type: 'string', enum: [...TRIGGER_TYPES] },
          labels: { type: 'array', items: { type: 'object' } },
          references: { type: 'array', items: { type: 'object' } },
          metadata: { type: 'object' },
        },
      },
    },
    {
      name: 'tuberosa_list_reflection_drafts',
      title: 'List Tuberosa Reflection Drafts',
      description: 'List pending or reviewed reflection drafts for review workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          status: { type: 'string', enum: [...REFLECTION_DRAFT_STATUSES] },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'tuberosa_get_reflection_draft',
      title: 'Get Tuberosa Reflection Draft',
      description: 'Read one reflection draft and its provenance, duplicate candidates, labels, and references.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reflectionDraftId: { type: 'string' },
        },
      },
    },
    {
      name: 'tuberosa_review_reflection_draft',
      title: 'Review Tuberosa Reflection Draft',
      description: 'Approve, reject, or mark a reflection draft as needing changes with compact rubric metadata.',
      inputSchema: {
        type: 'object',
        required: ['decision'],
        properties: {
          id: { type: 'string' },
          reflectionDraftId: { type: 'string' },
          decision: { type: 'string', enum: ['approve', 'reject', 'needs_changes'] },
          reviewer: { type: 'string' },
          reviewerNote: { type: 'string' },
          evaluation: {
            type: 'object',
            properties: {
              accuracy: { type: 'string', enum: ['pass', 'concern', 'fail'] },
              usefulness: { type: 'string', enum: ['pass', 'concern', 'fail'] },
              scope: { type: 'string', enum: ['pass', 'concern', 'fail'] },
              privacySafety: { type: 'string', enum: ['pass', 'concern', 'fail'] },
              labels: { type: 'string', enum: ['pass', 'concern', 'fail'] },
              references: { type: 'string', enum: ['pass', 'concern', 'fail'] },
              duplicateRisk: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
          },
          metadata: { type: 'object' },
        },
      },
    },
    {
      name: 'tuberosa_feedback_context',
      title: 'Record Tuberosa Context Feedback',
      description: 'Record whether a context pack was selected, rejected, stale, irrelevant, or missing important context.',
      inputSchema: {
        type: 'object',
        required: ['feedbackType'],
        properties: {
          contextPackId: { type: 'string' },
          project: { type: 'string' },
          feedbackType: { type: 'string', enum: [...FEEDBACK_TYPES] },
          reason: { type: 'string' },
          rejectedKnowledgeIds: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object' },
        },
      },
    },
    {
      name: 'tuberosa_collect_context_quality_feedback',
      title: 'Collect Context Quality Feedback',
      description: 'Collect noisy or missing-context feedback with linked packs, sessions, review records, and suggested actions.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          feedbackType: { type: 'string', enum: [...CONTEXT_QUALITY_FEEDBACK_TYPES] },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'tuberosa_record_error_log',
      title: 'Record Tuberosa Error Log',
      description: 'Save a sanitized development or runtime error to the physical Tuberosa error-log journal.',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
          project: { type: 'string' },
          category: { type: 'string' },
          severity: { type: 'string' },
          status: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          message: { type: 'string' },
          stack: { type: 'string' },
          toolName: { type: 'string' },
          operation: { type: 'string' },
          command: { type: 'string' },
          cwd: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          symbols: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          agentName: { type: 'string' },
          agentTool: { type: 'string' },
          sessionId: { type: 'string' },
          contextPackId: { type: 'string' },
          reflectionDraftId: { type: 'string' },
          references: { type: 'array', items: { type: 'object' } },
          metadata: { type: 'object' },
          fingerprint: { type: 'string' },
        },
      },
    },
    {
      name: 'tuberosa_list_error_logs',
      title: 'List Tuberosa Error Logs',
      description: 'List filesystem-backed error incidents by project, category, severity, status, query, or tag.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          category: { type: 'string' },
          severity: { type: 'string' },
          status: { type: 'string' },
          query: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'tuberosa_collect_error_logs',
      title: 'Collect Tuberosa Error Logs',
      description: 'Collect matching filesystem-backed error incidents into compact agent context, rollups, and fingerprint clusters.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          categories: { type: 'array', items: { type: 'string' } },
          severities: { type: 'array', items: { type: 'string' } },
          statuses: { type: 'array', items: { type: 'string' } },
          query: { type: 'string' },
          tag: { type: 'string' },
          since: { type: 'string' },
          until: { type: 'string' },
          limit: { type: 'number' },
          offset: { type: 'number' },
        },
      },
    },
    {
      name: 'tuberosa_create_error_log_reflection_draft',
      title: 'Create Error Log Reflection Draft',
      description: 'Create a pending reflection draft from selected error logs and optionally link it back to those incidents.',
      inputSchema: {
        type: 'object',
        required: ['errorLogIds'],
        properties: {
          errorLogIds: { type: 'array', items: { type: 'string' } },
          project: { type: 'string' },
          title: { type: 'string' },
          summary: { type: 'string' },
          content: { type: 'string' },
          linkLogs: { type: 'boolean' },
          metadata: { type: 'object' },
        },
      },
    },
    {
      name: 'tuberosa_get_error_log',
      title: 'Get Tuberosa Error Log',
      description: 'Read one filesystem-backed error incident by id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          errorLogId: { type: 'string' },
        },
      },
    },
    {
      name: 'tuberosa_update_error_log',
      title: 'Update Tuberosa Error Log',
      description: 'Update status, category, notes, references, or reflection linkage for an error incident.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          errorLogId: { type: 'string' },
          status: { type: 'string' },
          category: { type: 'string' },
          severity: { type: 'string' },
          summary: { type: 'string' },
          notes: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          references: { type: 'array', items: { type: 'object' } },
          reflectionDraftId: { type: ['string', 'null'] },
          metadata: { type: 'object' },
        },
      },
    },
    {
      name: 'tuberosa_resolve_error_log',
      title: 'Resolve Tuberosa Error Log',
      description: 'Mark an error incident resolved with root cause, fix summary, changed files, verification commands, and optional reflection linkage.',
      inputSchema: {
        type: 'object',
        required: ['rootCause', 'resolutionSummary'],
        properties: {
          id: { type: 'string' },
          errorLogId: { type: 'string' },
          status: { type: 'string', enum: ['fixed', 'wont_fix'] },
          rootCause: { type: 'string' },
          resolutionSummary: { type: 'string' },
          changedFiles: { type: 'array', items: { type: 'string' } },
          verificationCommands: { type: 'array', items: { type: 'string' } },
          reflectionDraftId: { type: 'string' },
          notes: { type: 'string' },
          metadata: { type: 'object' },
        },
      },
    },
  ];
}

function prompts() {
  return [
    {
      name: 'tuberosa_bootstrap_session',
      title: 'Bootstrap Session With Tuberosa',
      description: 'Search and confirm relevant project knowledge before work starts.',
      arguments: [
        { name: 'prompt', description: 'The user task prompt.', required: false },
      ],
    },
    {
      name: 'tuberosa_reflect_after_task',
      title: 'Reflect After Task',
      description: 'Draft a normalized learning memory after a useful agent learning event.',
      arguments: [],
    },
    {
      name: 'tuberosa_review_pending_reflections',
      title: 'Review Pending Reflections',
      description: 'List, inspect, and record decisions for pending reflection drafts.',
      arguments: [
        { name: 'project', description: 'Optional project filter for pending drafts.', required: false },
      ],
    },
    {
      name: 'tuberosa_capture_error_for_later',
      title: 'Capture Error For Later',
      description: 'Record a failed command, MCP tool, HTTP call, or debugging dead end as a physical error log.',
      arguments: [
        { name: 'project', description: 'Optional project for the incident.', required: false },
      ],
    },
    {
      name: 'tuberosa_review_error_logs',
      title: 'Review Error Logs',
      description: 'Collect error-log incidents and create reviewed learning candidates for durable agent memory.',
      arguments: [
        { name: 'project', description: 'Optional project filter for incidents.', required: false },
      ],
    },
    {
      name: 'tuberosa_fix_error_log',
      title: 'Fix Error Log',
      description: 'Guide an agent to fix an incident, verify the change, and record resolution metadata.',
      arguments: [
        { name: 'errorLogId', description: 'Optional specific error log id to fix.', required: false },
        { name: 'project', description: 'Optional project filter for incident context.', required: false },
      ],
    },
  ];
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

function shouldAutoCapture(services: AppServices, error: AppError): boolean {
  if (!services.config.errorLogAutoCapture) {
    return false;
  }

  return services.config.errorLogCaptureClientErrors || error.status >= 500;
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

function readToolName(request: JsonRpcRequest): string | undefined {
  if (request.method !== 'tools/call') {
    return undefined;
  }
  const params = request.params;
  return typeof params?.name === 'string' ? params.name : undefined;
}

function readToolArguments(request: JsonRpcRequest): Record<string, unknown> {
  if (request.method !== 'tools/call') {
    return {};
  }
  const args = request.params?.arguments;
  return args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function toolJson(value: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

function resourceJson(uri: string, value: unknown) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
