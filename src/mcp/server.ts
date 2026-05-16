import type { AppServices } from '../app.js';
import { NotFoundError, ValidationError } from '../errors.js';
import type { ContextFitStatus } from '../types.js';
import {
  expectRecord,
  validateContextPackIdArguments,
  validateContextSearchInput,
  validateFeedbackInput,
  validateReflectionDraftInput,
} from '../validation.js';

interface JsonRpcRequest {
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export async function handleMcpRequest(services: AppServices, request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: '2025-06-18',
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
      return callTool(services, expectRecord(request.params ?? {}, 'tools/call params'));

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
        ],
      };

    case 'resources/read':
      return readResource(services, expectRecord(request.params ?? {}, 'resources/read params'));

    case 'prompts/list':
      return { prompts: prompts() };

    case 'prompts/get':
      return getPrompt(expectRecord(request.params ?? {}, 'prompts/get params'));

    default:
      throw new NotFoundError(`Unsupported MCP method: ${request.method}`);
  }
}

async function callTool(services: AppServices, params: Record<string, unknown>) {
  const name = readRequiredMcpString(params.name, 'tools/call params.name');
  const args = expectRecord(params.arguments ?? {}, 'tools/call params.arguments');

  switch (name) {
    case 'tuberosa_search_context': {
      const pack = await services.retrieval.searchContext(validateContextSearchInput(args));
      return toolJson({
        contextPackId: pack.id,
        confidence: pack.confidence,
        contextFit: pack.contextFit,
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
            references: item.references,
          })),
        })),
        ...(pack.debug ? { debug: pack.debug } : {}),
        instruction: searchInstruction(pack.contextFit?.fitStatus),
      });
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
      return toolJson({
        ...draft,
        instruction: 'This reflection is pending review. Approve it before it becomes searchable memory.',
      });
    }

    case 'tuberosa_feedback_context': {
      return toolJson(await services.retrieval.recordFeedback(validateFeedbackInput(args)));
    }

    default:
      throw new ValidationError(`Unknown Tuberosa tool: ${name}`);
  }
}

function searchInstruction(fitStatus: ContextFitStatus | undefined): string {
  if (fitStatus === 'insufficient') {
    return 'Context fit is insufficient. Ask a clarifying question or continue with fresh context instead of relying on this pack.';
  }

  if (fitStatus === 'needs_confirmation') {
    return 'Context fit needs confirmation. Review the shortlist and confirm it is appropriate before using the full pack.';
  }

  return 'Review the shortlist. Call tuberosa_get_context_pack only after the user or agent confirms this pack is appropriate.';
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
              'Before starting the task, call tuberosa_search_context with the user prompt, current project, cwd, files, symbols, and errors when known.',
              'Show the ranked shortlist with confidence and source references.',
              'If the context is rejected, call tuberosa_feedback_context and retry once. If it still misses, continue with fresh context and ask a clarifying question.',
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
          taskType: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          symbols: { type: 'array', items: { type: 'string' } },
          errors: { type: 'array', items: { type: 'string' } },
          tokenBudget: { type: 'number' },
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
          itemType: { type: 'string' },
          triggerType: { type: 'string' },
          labels: { type: 'array', items: { type: 'object' } },
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
          feedbackType: { type: 'string' },
          reason: { type: 'string' },
          rejectedKnowledgeIds: { type: 'array', items: { type: 'string' } },
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
  ];
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
