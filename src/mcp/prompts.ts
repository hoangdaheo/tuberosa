// MCP prompt registry + getter. Pure data/functions — no runtime server state.
import { ValidationError } from '../errors.js';

export function getPrompt(params: Record<string, unknown>) {
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
              'Before starting the task, call tuberosa_start_session with the user prompt as-is, then enrich it yourself with current project, cwd, files, symbols, errors, contextMode layered, noiseTolerance strict, and includeDeepContext true when known.',
              'Use returned deep context when deepContextReturned is true; otherwise inspect the shortlist and fetch the full pack only after confirming it is appropriate.',
              'Record selected, rejected, stale, irrelevant, or missing_context with tuberosa_record_context_decision before finishing the session.',
              'During or after the work, call tuberosa_capture_learning_signal for durable tips, decisions, mistakes, verification commands, file changes, user preferences, or follow-ups that should inform future agents.',
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

export function prompts() {
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
