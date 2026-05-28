import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AppServices } from '../app.js';
import type { AppConfig } from '../config.js';
import { AppError, appErrorToHttpBody, type AppErrorCode, NotFoundError, toAppError } from '../errors.js';
import { buildWorkbenchSummary } from '../operations/workbench-summary.js';
import { computeAtomGateStats } from '../operations/atom-gate-stats.js';
import { getCatchupMetadata } from '../operations/catchup.js';
import type { KnowledgeConflictStatus, KnowledgeRelationType } from '../types.js';
import {
  validateAppendAgentSessionNoteInput,
  validateCaptureAgentLearningSignalInput,
  validateContextSearchInput,
  validateBackupRetentionInput,
  validateCollectErrorLogsInput,
  validateContextQualityReportInput,
  validateCleanupOperationsInput,
  validateCreateBackupInput,
  validateCreateErrorLogReflectionDraftInput,
  validateErrorLogInput,
  validateErrorLogListInput,
  validateErrorLogPatchInput,
  validateFeedbackInput,
  validateFinishAgentSessionInput,
  validateIngestFilesRequest,
  validateKnowledgeInput,
  validateKnowledgePatchInput,
  validateKnowledgeConflictPatchInput,
  validateKnowledgeGapPatchInput,
  validateKnowledgeRelationInput,
  validateKnowledgeRelationPatchInput,
  validateKnowledgeReviewFilter,
  validateKnowledgeStatusQuery,
  validateLearningProposalPatchInput,
  validateLearningProposalTypeQuery,
  validateLearningReviewStatusQuery,
  validateMaintenanceApplyInput,
  validateMaintenanceProposeInput,
  validateRecordAgentContextDecisionInput,
  validateReflectionDraftPatchInput,
  validateReflectionDraftInput,
  validateReflectionDraftReviewInput,
  validateRestoreBackupInput,
  validateResolveErrorLogInput,
  validateStartAgentSessionInput,
  validateWorkbenchSummaryInput,
} from '../validation.js';
import { readWorkbenchAsset, workbenchHtml } from './workbench-v2.js';

type RouteParams = Record<string, string>;
type RouteMatcher = (url: URL) => RouteParams | undefined;
type RouteHandler = (context: RouteContext) => Promise<RouteResult> | RouteResult;
type RouteResult = unknown | RawHttpResponse;
const RAW_RESPONSE = Symbol('raw_http_response');

interface RouteContext {
  services: AppServices;
  request: IncomingMessage;
  url: URL;
  params: RouteParams;
}

interface HttpRoute {
  method: string;
  match: RouteMatcher;
  handle: RouteHandler;
  public?: boolean;
}

interface RawHttpResponse {
  [RAW_RESPONSE]: true;
  status: number;
  contentType: string;
  body: string | Buffer;
}

export function createHttpServer(services: AppServices) {
  const router = new HttpRouter(services);

  const server = createServer(async (request, response) => {
    await router.handle(request, response);
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  return server;
}

export async function handleHttpRequest(
  services: AppServices,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const router = new HttpRouter(services);
  await router.handle(request, response);
}

class HttpRouter {
  private readonly routes: HttpRoute[];

  constructor(private readonly services: AppServices) {
    this.routes = createRoutes();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method?.toUpperCase() ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');

    try {
      const matched = this.matchRoute(method, url);
      if (!matched) {
        throw new HttpError(404, `No route for ${method} ${url.pathname}`);
      }

      if (!matched.route.public) {
        authenticate(request, this.services.config);
      }

      const body = await matched.route.handle({
        services: this.services,
        request,
        url,
        params: matched.params,
      });
      if (isRawHttpResponse(body)) {
        sendRaw(response, body);
      } else {
        sendJson(response, 200, body);
      }
    } catch (error) {
      const appError = toAppError(error);
      await maybeCaptureHttpError(this.services, request, url, method, appError);
      sendJson(response, appError.status, appErrorToHttpBody(appError));
    }
  }

  private matchRoute(method: string, url: URL): { route: HttpRoute; params: RouteParams } | undefined {
    for (const route of this.routes) {
      if (route.method !== method) {
        continue;
      }

      const params = route.match(url);
      if (params) {
        return { route, params };
      }
    }

    return undefined;
  }
}

function createRoutes(): HttpRoute[] {
  return [
    {
      method: 'GET',
      match: exactPath('/health'),
      public: true,
      handle: ({ services }) => ({
        ok: true,
        service: 'tuberosa',
        store: services.config.store,
        durability: services.config.store === 'postgres' ? 'persistent' : 'ephemeral',
        backupDir: services.config.backupDir,
        cache: services.config.cache,
        modelProvider: services.config.modelProvider,
      }),
    },
    {
      method: 'GET',
      match: exactPath('/workbench'),
      public: true,
      handle: () => rawResponse('text/html; charset=utf-8', workbenchHtml()),
    },
    {
      method: 'GET',
      match: pathPattern(/^\/workbench\/static\/(.+)$/, ['asset']),
      public: true,
      handle: async ({ params }) => {
        const asset = await readWorkbenchAsset(params.asset);
        if (!asset) {
          throw new NotFoundError(`Workbench asset not found: ${params.asset}`);
        }
        return rawResponse(asset.contentType, asset.body);
      },
    },
    {
      method: 'POST',
      match: exactPath('/context/search'),
      handle: async ({ services, request }) => {
        const body = validateContextSearchInput(await readJsonBody(request, services.config.maxRequestBytes));
        const pack = await services.retrieval.searchContext(body);
        services.operations.requestPhysicalMirror('context-searched');
        return pack;
      },
    },
    {
      method: 'GET',
      match: exactPath('/context/packs'),
      handle: ({ services, url }) => services.operations.listContextPacks(readListRecordsOptions(url)),
    },
    {
      method: 'GET',
      match: pathPattern(/^\/context\/packs\/([^/]+)$/, ['id']),
      handle: async ({ services, params }) => {
        const pack = await services.retrieval.getContextPack(params.id);
        if (!pack) {
          throw new NotFoundError('Context pack not found.');
        }

        return pack;
      },
    },
    {
      method: 'POST',
      match: exactPath('/context/feedback'),
      handle: async ({ services, request }) => {
        const body = validateFeedbackInput(await readJsonBody(request, services.config.maxRequestBytes));
        const result = await services.retrieval.recordFeedback(body);
        services.operations.requestPhysicalMirror('context-feedback-recorded');
        return result;
      },
    },
    {
      method: 'POST',
      match: pathPattern(/^\/atoms\/([^/]+)\/resurrect$/, ['id']),
      handle: async ({ services, params }) => {
        const atom = await services.store.updateAtom(params.id, {
          status: 'active',
          lastReusedAt: new Date().toISOString(),
        });
        if (!atom) {
          throw new NotFoundError('Atom not found.');
        }
        services.operations.requestPhysicalMirror('atom-resurrected');
        return { atom };
      },
    },
    {
      method: 'GET',
      match: exactPath('/operations/atom-gate/stats'),
      handle: ({ services, url }) => {
        const project = url.searchParams.get('project') ?? undefined;
        const window = url.searchParams.get('window');
        const windowDays = window === '30d' ? 30 : 7;
        return computeAtomGateStats(services.store, { project, windowDays });
      },
    },
    {
      method: 'POST',
      match: exactPath('/agent-sessions'),
      handle: async ({ services, request }) => {
        const body = validateStartAgentSessionInput(await readJsonBody(request, services.config.maxRequestBytes));
        const result = await services.agentSessions.startSession(body);
        services.operations.requestPhysicalMirror('agent-session-started');
        return result;
      },
    },
    {
      method: 'GET',
      match: exactPath('/agent-sessions'),
      handle: ({ services, url }) => services.operations.listAgentSessions(readListRecordsOptions(url)),
    },
    {
      method: 'GET',
      match: pathPattern(/^\/agent-sessions\/([^/]+)$/, ['id']),
      handle: async ({ services, params }) => {
        const session = await services.operations.getAgentSession(params.id);
        if (!session) {
          throw new NotFoundError('Agent session not found.');
        }

        return session;
      },
    },
    {
      method: 'GET',
      match: pathPattern(/^\/agent-sessions\/([^/]+)\/context-decisions$/, ['id']),
      handle: ({ services, params, url }) => services.operations.listAgentContextDecisions({
        sessionId: params.id,
        limit: readLimit(url),
      }),
    },
    {
      method: 'POST',
      match: pathPattern(/^\/agent-sessions\/([^/]+)\/context-decision$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateRecordAgentContextDecisionInput(
          await readJsonBody(request, services.config.maxRequestBytes),
          params.id,
        );
        const result = await services.agentSessions.recordContextDecision(body);
        services.operations.requestPhysicalMirror('agent-context-decision-recorded');
        return result;
      },
    },
    {
      method: 'POST',
      match: pathPattern(/^\/agent-sessions\/([^/]+)\/learning-signals$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateCaptureAgentLearningSignalInput(
          await readJsonBody(request, services.config.maxRequestBytes),
          params.id,
        );
        const result = await services.agentSessions.captureLearningSignal(body);
        services.operations.requestPhysicalMirror('agent-learning-signal-captured');
        return result;
      },
    },
    {
      method: 'POST',
      match: pathPattern(/^\/agent-sessions\/([^/]+)\/finish$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateFinishAgentSessionInput(
          await readJsonBody(request, services.config.maxRequestBytes),
          params.id,
        );
        const result = await services.agentSessions.finishSession(body);
        services.operations.requestPhysicalMirror('agent-session-finished');
        return result;
      },
    },
    {
      method: 'POST',
      match: pathPattern(/^\/agent-sessions\/([^/]+)\/notes$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateAppendAgentSessionNoteInput(
          await readJsonBody(request, services.config.maxRequestBytes),
          params.id,
        );
        const result = await services.agentSessions.appendSessionNote(body);
        services.operations.requestPhysicalMirror('agent-session-note-appended');
        return result;
      },
    },
    {
      method: 'POST',
      match: exactPath('/ingest/files'),
      handle: async ({ services, request }) => {
        const body = validateIngestFilesRequest(await readJsonBody(request, services.config.maxRequestBytes));
        const result = await services.ingestion.ingestFiles(body.project, body.files, { mode: body.mode });
        if (body.files.length > 1) {
          services.operations.requestWriteThroughBackup('bulk-ingest-files');
        }
        services.operations.requestPhysicalMirror('files-ingested');
        return result;
      },
    },
    {
      method: 'POST',
      match: exactPath('/knowledge'),
      handle: async ({ services, request }) => {
        const body = validateKnowledgeInput(await readJsonBody(request, services.config.maxRequestBytes));
        const knowledge = await services.ingestion.ingestKnowledge(body);
        services.operations.requestPhysicalMirror('knowledge-ingested');
        return knowledge;
      },
    },
    {
      method: 'GET',
      match: exactPath('/knowledge'),
      handle: ({ services, url }) => services.operations.listKnowledge({
        project: url.searchParams.get('project') ?? undefined,
        query: url.searchParams.get('q') ?? undefined,
        status: validateKnowledgeStatusQuery(url.searchParams.get('status')),
        review: validateKnowledgeReviewFilter(url.searchParams.get('review')),
        limit: readLimit(url),
      }),
    },
    {
      method: 'GET',
      match: pathPattern(/^\/knowledge\/([^/]+)$/, ['id']),
      handle: async ({ services, params }) => {
        const knowledge = await services.operations.getKnowledge(params.id);
        if (!knowledge) {
          throw new NotFoundError('Knowledge item not found.');
        }

        return knowledge;
      },
    },
    {
      method: 'PATCH',
      match: pathPattern(/^\/knowledge\/([^/]+)$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateKnowledgePatchInput(await readJsonBody(request, services.config.maxRequestBytes));
        const knowledge = await services.operations.updateKnowledge(params.id, body);
        if (!knowledge) {
          throw new NotFoundError('Knowledge item not found.');
        }

        return knowledge;
      },
    },
    {
      method: 'GET',
      match: exactPath('/labels'),
      handle: ({ services, url }) => services.operations.listLabels({
        project: url.searchParams.get('project') ?? undefined,
        limit: readLimit(url),
      }),
    },
    {
      method: 'GET',
      match: exactPath('/operations/relations'),
      handle: ({ services, url }) => services.operations.listKnowledgeRelations(readRelationListOptions(url)),
    },
    {
      method: 'POST',
      match: exactPath('/operations/relations'),
      handle: async ({ services, request }) => {
        const body = validateKnowledgeRelationInput(await readJsonBody(request, services.config.maxRequestBytes));
        return services.operations.createKnowledgeRelation(body);
      },
    },
    {
      method: 'GET',
      match: pathPattern(/^\/operations\/relations\/([^/]+)$/, ['id']),
      handle: async ({ services, params }) => {
        const relation = await services.operations.getKnowledgeRelation(params.id);
        if (!relation) {
          throw new NotFoundError('Knowledge relation not found.');
        }

        return relation;
      },
    },
    {
      method: 'PATCH',
      match: pathPattern(/^\/operations\/relations\/([^/]+)$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateKnowledgeRelationPatchInput(await readJsonBody(request, services.config.maxRequestBytes));
        const relation = await services.operations.updateKnowledgeRelation(params.id, body);
        if (!relation) {
          throw new NotFoundError('Knowledge relation not found.');
        }

        return relation;
      },
    },
    {
      method: 'DELETE',
      match: pathPattern(/^\/operations\/relations\/([^/]+)$/, ['id']),
      handle: async ({ services, params }) => {
        const deleted = await services.operations.deleteKnowledgeRelation(params.id);
        if (!deleted) {
          throw new NotFoundError('Knowledge relation not found.');
        }

        return { deleted: true };
      },
    },
    {
      method: 'GET',
      match: exactPath('/operations/conflicts'),
      handle: ({ services, url }) => services.operations.listKnowledgeConflicts(readConflictListOptions(url)),
    },
    {
      method: 'POST',
      match: exactPath('/operations/conflicts/detect'),
      handle: ({ services, url }) => services.operations.detectKnowledgeConflicts({
        project: url.searchParams.get('project') ?? undefined,
        limit: readLimit(url),
      }),
    },
    {
      method: 'PATCH',
      match: pathPattern(/^\/operations\/conflicts\/([^/]+)$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateKnowledgeConflictPatchInput(await readJsonBody(request, services.config.maxRequestBytes));
        const conflict = await services.operations.updateKnowledgeConflict(params.id, body);
        if (!conflict) {
          throw new NotFoundError('Knowledge conflict not found.');
        }

        return conflict;
      },
    },
    {
      method: 'GET',
      match: exactPath('/operations/knowledge-gaps'),
      handle: ({ services, url }) => services.operations.listKnowledgeGaps(readKnowledgeGapListOptions(url)),
    },
    {
      method: 'PATCH',
      match: pathPattern(/^\/operations\/knowledge-gaps\/([^/]+)$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateKnowledgeGapPatchInput(await readJsonBody(request, services.config.maxRequestBytes));
        const gap = await services.operations.updateKnowledgeGap(params.id, body);
        if (!gap) {
          throw new NotFoundError('Knowledge gap not found.');
        }

        return gap;
      },
    },
    {
      method: 'GET',
      match: exactPath('/operations/learning-proposals'),
      handle: ({ services, url }) => services.operations.listLearningProposals(readLearningProposalListOptions(url)),
    },
    {
      method: 'PATCH',
      match: pathPattern(/^\/operations\/learning-proposals\/([^/]+)$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateLearningProposalPatchInput(await readJsonBody(request, services.config.maxRequestBytes));
        const proposal = await services.operations.updateLearningProposal(params.id, body);
        if (!proposal) {
          throw new NotFoundError('Learning proposal not found.');
        }

        return proposal;
      },
    },
    {
      method: 'GET',
      match: exactPath('/operations/organization/project-map'),
      handle: ({ services, url }) => services.operations.exportProjectMap({
        project: url.searchParams.get('project') ?? undefined,
        limit: readLimit(url),
      }),
    },
    {
      method: 'GET',
      match: exactPath('/operations/organization/knowledge-graph.jsonl'),
      handle: ({ services, url }) => services.operations.exportKnowledgeGraphJsonl({
        project: url.searchParams.get('project') ?? undefined,
        limit: readLimit(url),
      }),
    },
    {
      method: 'GET',
      match: exactPath('/operations/organization/readable-summary'),
      handle: ({ services, url }) => services.operations.exportReadableSummary({
        project: url.searchParams.get('project') ?? undefined,
        limit: readLimit(url),
      }),
    },
    {
      method: 'GET',
      match: exactPath('/operations/context-quality'),
      handle: ({ services, url }) => services.operations.collectContextQualityFeedback(
        readContextQualityReportOptions(url),
      ),
    },
    {
      method: 'GET',
      match: exactPath('/operations/workbench/summary'),
      handle: ({ services, url }) => buildWorkbenchSummary(services, readWorkbenchSummaryOptions(url)),
    },
    {
      method: 'GET',
      match: pathPattern(/^\/operations\/workbench\/session\/([^/]+)\/replay$/, ['id']),
      handle: async ({ services, params }) => {
        const bundle = await services.sessionReplay.readReplay(params.id);
        if (!bundle) {
          throw new NotFoundError('replay not found');
        }

        return bundle;
      },
    },
    {
      method: 'POST',
      match: exactPath('/operations/maintenance/preview'),
      handle: async ({ services, request }) => {
        const body = validateMaintenanceProposeInput(
          await readJsonBody(request, services.config.maxRequestBytes),
        );
        return services.maintenance.propose(body);
      },
    },
    {
      method: 'POST',
      match: exactPath('/operations/maintenance/apply'),
      handle: async ({ services, request }) => {
        const body = validateMaintenanceApplyInput(
          await readJsonBody(request, services.config.maxRequestBytes),
        );
        const result = await services.maintenance.apply(body);
        services.operations.requestPhysicalMirror('maintenance-applied');
        return result;
      },
    },
    {
      method: 'GET',
      match: exactPath('/operations/catchup'),
      handle: async ({ services, url }) => {
        const summary = await buildWorkbenchSummary(services, readWorkbenchSummaryOptions(url));
        const catchup = getCatchupMetadata();
        return { catchup, summary };
      },
    },
    {
      method: 'POST',
      match: exactPath('/operations/error-logs'),
      handle: async ({ services, request }) => {
        const body = validateErrorLogInput(await readJsonBody(request, services.config.maxRequestBytes));
        return services.errorLogs.recordLog(body);
      },
    },
    {
      method: 'GET',
      match: exactPath('/operations/error-logs'),
      handle: ({ services, url }) => services.errorLogs.listLogs(readErrorLogListOptions(url)),
    },
    {
      method: 'GET',
      match: exactPath('/operations/error-logs/collection'),
      handle: ({ services, url }) => services.errorLogInsights.collect(readErrorLogCollectionOptions(url)),
    },
    {
      method: 'POST',
      match: exactPath('/operations/error-logs/reflection-drafts'),
      handle: async ({ services, request }) => {
        const body = validateCreateErrorLogReflectionDraftInput(
          await readJsonBody(request, services.config.maxRequestBytes),
        );
        const result = await services.errorLogInsights.createReflectionDraft(body);
        services.operations.requestPhysicalMirror('error-log-reflection-created');
        return result;
      },
    },
    {
      method: 'POST',
      match: pathPattern(/^\/operations\/error-logs\/([^/]+)\/resolve$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateResolveErrorLogInput(
          await readJsonBody(request, services.config.maxRequestBytes),
          params.id,
        );
        const result = await services.errorLogInsights.resolve(body);
        if (!result) {
          throw new NotFoundError('Error log not found.');
        }

        return result;
      },
    },
    {
      method: 'GET',
      match: pathPattern(/^\/operations\/error-logs\/([^/]+)$/, ['id']),
      handle: async ({ services, params }) => {
        const log = await services.errorLogs.getLog(params.id);
        if (!log) {
          throw new NotFoundError('Error log not found.');
        }

        return log;
      },
    },
    {
      method: 'PATCH',
      match: pathPattern(/^\/operations\/error-logs\/([^/]+)$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateErrorLogPatchInput(await readJsonBody(request, services.config.maxRequestBytes));
        const log = await services.errorLogs.updateLog(params.id, body);
        if (!log) {
          throw new NotFoundError('Error log not found.');
        }

        return log;
      },
    },
    {
      method: 'GET',
      match: exactPath('/feedback-events'),
      handle: ({ services, url }) => services.operations.listFeedbackEvents(readListRecordsOptions(url)),
    },
    {
      method: 'POST',
      match: exactPath('/reflection-drafts'),
      handle: async ({ services, request }) => {
        const body = validateReflectionDraftInput(await readJsonBody(request, services.config.maxRequestBytes));
        const draft = await services.reflection.createDraft(body);
        services.operations.requestPhysicalMirror('reflection-created');
        return draft;
      },
    },
    {
      method: 'GET',
      match: exactPath('/reflection-drafts'),
      handle: ({ services, url }) => services.operations.listReflectionDrafts(readListRecordsOptions(url)),
    },
    {
      method: 'GET',
      match: pathPattern(/^\/reflection-drafts\/([^/]+)$/, ['id']),
      handle: async ({ services, params }) => {
        const draft = await services.operations.getReflectionDraft(params.id);
        if (!draft) {
          throw new NotFoundError('Reflection draft not found.');
        }

        return draft;
      },
    },
    {
      method: 'PATCH',
      match: pathPattern(/^\/reflection-drafts\/([^/]+)$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateReflectionDraftPatchInput(await readJsonBody(request, services.config.maxRequestBytes));
        const draft = await services.reflection.updateDraft(params.id, body);
        if (!draft) {
          throw new NotFoundError('Reflection draft not found.');
        }

        services.operations.requestPhysicalMirror('reflection-updated');
        return draft;
      },
    },
    {
      method: 'POST',
      match: pathPattern(/^\/reflection-drafts\/([^/]+)\/review$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateReflectionDraftReviewInput({
          ...await readJsonBody(request, services.config.maxRequestBytes),
          id: params.id,
        });
        const draft = await services.reflection.reviewDraft(body);
        if (!draft) {
          throw new NotFoundError('Reflection draft not found.');
        }

        services.operations.requestWriteThroughBackup('reflection-reviewed');
        services.operations.requestPhysicalMirror('reflection-reviewed');
        return draft;
      },
    },
    {
      method: 'GET',
      match: pathPattern(/^\/reflection-drafts\/([^/]+)\/recommendation$/, ['id']),
      handle: async ({ services, params }) => {
        const recommendation = await services.reflection.recommendDraft(params.id);
        if (!recommendation) {
          throw new NotFoundError('Reflection draft not found.');
        }
        return recommendation;
      },
    },
    {
      method: 'POST',
      match: pathPattern(/^\/reflection-drafts\/([^/]+)\/approve$/, ['id']),
      handle: async ({ services, params }) => {
        const draft = await services.reflection.approveDraft(params.id);
        if (!draft) {
          throw new NotFoundError('Reflection draft not found.');
        }

        services.operations.requestWriteThroughBackup('reflection-approved');
        services.operations.requestPhysicalMirror('reflection-approved');
        return draft;
      },
    },
    {
      method: 'POST',
      match: exactPath('/operations/import-files'),
      handle: async ({ services, request }) => {
        const body = validateIngestFilesRequest(await readJsonBody(request, services.config.maxRequestBytes));
        return services.operations.importFiles(body);
      },
    },
    {
      method: 'POST',
      match: exactPath('/operations/cleanup'),
      handle: async ({ services, request }) => {
        const body = validateCleanupOperationsInput(await readJsonBody(request, services.config.maxRequestBytes));
        return services.operations.cleanup(body);
      },
    },
    {
      method: 'POST',
      match: exactPath('/operations/backups'),
      handle: async ({ services, request }) => {
        const body = validateCreateBackupInput(await readJsonBody(request, services.config.maxRequestBytes));
        return services.operations.createBackup(body);
      },
    },
    {
      method: 'GET',
      match: exactPath('/operations/backups'),
      handle: ({ services }) => services.operations.listBackups(),
    },
    {
      method: 'GET',
      match: exactPath('/operations/backups/status'),
      handle: ({ services }) => services.operations.getBackupStatus(),
    },
    {
      method: 'POST',
      match: exactPath('/operations/backups/prune'),
      handle: async ({ services, request }) => {
        const body = validateBackupRetentionInput(await readJsonBody(request, services.config.maxRequestBytes));
        return services.operations.pruneBackups(body);
      },
    },
    {
      method: 'POST',
      match: pathPattern(/^\/operations\/backups\/([^/]+)\/verify$/, ['id']),
      handle: ({ services, params }) => services.operations.verifyBackup({ backupIdOrPath: params.id }),
    },
    {
      method: 'POST',
      match: pathPattern(/^\/operations\/backups\/([^/]+)\/restore$/, ['id']),
      handle: async ({ services, request, params }) => {
        const body = validateRestoreBackupInput(
          await readJsonBody(request, services.config.maxRequestBytes),
          params.id,
        );
        return services.operations.restoreBackup(body);
      },
    },
  ];
}

export async function readJsonBody<T = Record<string, unknown>>(request: IncomingMessage, maxBytes: number): Promise<T> {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (contentLength > maxBytes) {
    throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes.`);
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {} as T;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new HttpError(400, 'Invalid JSON body.');
  }
}

function authenticate(request: IncomingMessage, config: AppConfig): void {
  if (!isAuthorizedRequest(request, config)) {
    throw new HttpError(401, 'Unauthorized.');
  }
}

function readProvidedApiKey(request: IncomingMessage): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }

  const header = request.headers['x-tuberosa-api-key'];
  return Array.isArray(header) ? header[0] : header;
}

export function isAuthorizedApiKey(provided: string | undefined, apiKey: string | undefined): boolean {
  if (!apiKey) {
    return true;
  }

  return Boolean(provided && secureEqual(provided, apiKey));
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackRequest(request: IncomingMessage): boolean {
  const remote = request.socket?.remoteAddress;
  return typeof remote === 'string' && LOOPBACK_ADDRESSES.has(remote);
}

export function isAuthorizedRequest(request: IncomingMessage, config: AppConfig): boolean {
  const provided = readProvidedApiKey(request);
  if (config.apiKey) {
    return Boolean(provided && secureEqual(provided, config.apiKey));
  }
  if (!config.requireApiKeyForNonLoopback) {
    return true;
  }
  return isLoopbackRequest(request);
}

function secureEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
} as const;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(body, null, 2);
  } catch (stringifyError) {
    // Fallback for circular refs / BigInts so the error handler never re-throws.
    encoded = JSON.stringify({
      code: 'internal_error',
      status: 500,
      message: 'Failed to serialize response body.',
      detail: stringifyError instanceof Error ? stringifyError.message : String(stringifyError),
    });
    status = 500;
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(encoded),
    ...SECURITY_HEADERS,
  });
  response.end(encoded);
}

function rawResponse(contentType: string, body: string | Buffer, status = 200): RawHttpResponse {
  return {
    [RAW_RESPONSE]: true,
    status,
    contentType,
    body,
  };
}

function isRawHttpResponse(value: unknown): value is RawHttpResponse {
  return typeof value === 'object' && value !== null && (value as RawHttpResponse)[RAW_RESPONSE] === true;
}

function sendRaw(response: ServerResponse, body: RawHttpResponse): void {
  const encoded = Buffer.isBuffer(body.body) ? body.body : Buffer.from(body.body, 'utf8');
  response.writeHead(body.status, {
    'Content-Type': body.contentType,
    'Content-Length': encoded.length,
    ...SECURITY_HEADERS,
  });
  response.end(encoded);
}

export class HttpError extends AppError {
  constructor(status: number, message: string) {
    super({ code: httpErrorCode(status), status, message });
  }
}

function httpErrorCode(status: number): AppErrorCode {
  if (status === 404) {
    return 'not_found';
  }

  if (status === 413) {
    return 'ingestion_limit';
  }

  return 'validation_error';
}

function exactPath(pathname: string): RouteMatcher {
  return (url) => (url.pathname === pathname ? {} : undefined);
}

function pathPattern(pattern: RegExp, keys: string[]): RouteMatcher {
  return (url) => {
    const match = pattern.exec(url.pathname);
    if (!match) {
      return undefined;
    }

    try {
      return Object.fromEntries(
        keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]),
      );
    } catch {
      throw new HttpError(400, 'Invalid path parameter.');
    }
  };
}

function readLimit(url: URL): number {
  const rawLimit = url.searchParams.get('limit');
  if (!rawLimit) {
    return 25;
  }

  if (!/^\d+$/.test(rawLimit)) {
    throw new HttpError(400, 'Query parameter "limit" must be a positive integer.');
  }

  const limit = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new HttpError(400, 'Query parameter "limit" must be a positive integer.');
  }

  return Math.min(limit, 100);
}

function readListRecordsOptions(url: URL) {
  return {
    project: url.searchParams.get('project') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    limit: readLimit(url),
  };
}

function readErrorLogListOptions(url: URL) {
  return validateErrorLogListInput({
    project: url.searchParams.get('project') ?? undefined,
    category: url.searchParams.get('category') ?? undefined,
    severity: url.searchParams.get('severity') ?? undefined,
    status: url.searchParams.get('status') ?? undefined,
    query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    limit: readLimit(url),
  });
}

function readErrorLogCollectionOptions(url: URL) {
  return validateCollectErrorLogsInput({
    project: url.searchParams.get('project') ?? undefined,
    categories: readRepeatedQuery(url, 'category', 'categories'),
    severities: readRepeatedQuery(url, 'severity', 'severities'),
    statuses: readRepeatedQuery(url, 'status', 'statuses'),
    query: url.searchParams.get('q') ?? url.searchParams.get('query') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    since: url.searchParams.get('since') ?? undefined,
    until: url.searchParams.get('until') ?? undefined,
    limit: readOptionalQueryNumber(url, 'limit'),
    offset: readOptionalQueryNumber(url, 'offset'),
  });
}

function readRepeatedQuery(url: URL, singular: string, plural: string): string[] | undefined {
  const values = [
    ...url.searchParams.getAll(singular),
    ...url.searchParams.getAll(plural).flatMap((value) => value.split(',')),
  ].map((value) => value.trim()).filter(Boolean);

  return values.length > 0 ? values : undefined;
}

function readOptionalQueryNumber(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  return value === null ? undefined : Number(value);
}

function readRelationListOptions(url: URL) {
  const inferred = url.searchParams.get('inferred');
  if (inferred !== null && inferred !== 'true' && inferred !== 'false') {
    throw new HttpError(400, 'Query parameter "inferred" must be true or false.');
  }

  return {
    project: url.searchParams.get('project') ?? undefined,
    fromKnowledgeId: url.searchParams.get('fromKnowledgeId') ?? undefined,
    targetKnowledgeId: url.searchParams.get('targetKnowledgeId') ?? undefined,
    targetValue: url.searchParams.get('targetValue') ?? undefined,
    relationType: (url.searchParams.get('relationType') ?? undefined) as KnowledgeRelationType | undefined,
    inferred: inferred === null ? undefined : inferred === 'true',
    limit: readLimit(url),
  };
}

function readConflictListOptions(url: URL) {
  const status = url.searchParams.get('status');
  if (status !== null && !['open', 'resolved', 'dismissed'].includes(status)) {
    throw new HttpError(400, 'Query parameter "status" must be open, resolved, or dismissed.');
  }

  return {
    project: url.searchParams.get('project') ?? undefined,
    status: (status ?? undefined) as KnowledgeConflictStatus | undefined,
    limit: readLimit(url),
  };
}

function readKnowledgeGapListOptions(url: URL) {
  return {
    project: url.searchParams.get('project') ?? undefined,
    status: validateLearningReviewStatusQuery(url.searchParams.get('status')),
    sourceSessionId: url.searchParams.get('sourceSessionId') ?? undefined,
    contextPackId: url.searchParams.get('contextPackId') ?? undefined,
    limit: readLimit(url),
  };
}

function readLearningProposalListOptions(url: URL) {
  return {
    project: url.searchParams.get('project') ?? undefined,
    status: validateLearningReviewStatusQuery(url.searchParams.get('status')),
    proposalType: validateLearningProposalTypeQuery(url.searchParams.get('proposalType') ?? url.searchParams.get('type')),
    sourceSessionId: url.searchParams.get('sourceSessionId') ?? undefined,
    contextPackId: url.searchParams.get('contextPackId') ?? undefined,
    affectedKnowledgeId: url.searchParams.get('affectedKnowledgeId') ?? undefined,
    limit: readLimit(url),
  };
}

function readContextQualityReportOptions(url: URL) {
  return validateContextQualityReportInput({
    project: url.searchParams.get('project') ?? undefined,
    feedbackType: url.searchParams.get('feedbackType') ?? undefined,
    limit: readLimit(url),
  });
}

function readWorkbenchSummaryOptions(url: URL) {
  return validateWorkbenchSummaryInput({
    project: url.searchParams.get('project') ?? undefined,
    limit: readOptionalQueryNumber(url, 'limit'),
  });
}

async function maybeCaptureHttpError(
  services: AppServices,
  request: IncomingMessage,
  url: URL,
  method: string,
  error: AppError,
): Promise<void> {
  if (!shouldAutoCapture(services, error)) {
    return;
  }

  try {
    await services.errorLogs.recordLog({
      project: url.searchParams.get('project') ?? undefined,
      category: categoryForAppError(error),
      severity: error.status >= 500 ? 'error' : 'warning',
      title: `HTTP ${method} ${url.pathname} failed`,
      summary: `${error.code}: ${error.message}`,
      message: error.message,
      stack: error.stack,
      operation: `${method} ${url.pathname}`,
      agentTool: 'http',
      metadata: {
        surface: 'http',
        code: error.code,
        status: error.status,
        path: url.pathname,
        method,
        userAgent: request.headers['user-agent'],
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

function categoryForAppError(error: AppError) {
  switch (error.code) {
    case 'cache_error':
      return 'cache';
    case 'model_provider_error':
      return 'model_provider';
    case 'store_error':
      return 'database';
    default:
      return 'http';
  }
}
