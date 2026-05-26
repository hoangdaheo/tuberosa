export interface PlaybookStep {
  title: string;
  body: string;
  example?: string;
  action?: { kind: 'open_start' | 'open_review' | 'open_system'; label: string };
}

export interface Playbook {
  id: string;
  title: string;
  summary: string;
  steps: PlaybookStep[];
}

const PLAYBOOKS: Playbook[] = [
  {
    id: 'first-task',
    title: 'Run your first task',
    summary: 'Map a real agent task and inspect the context verdict.',
    steps: [
      { title: 'Paste the task', body: 'Use the Start page to describe the work the agent is about to do.', example: 'Fix the build failure in src/retrieval/service.ts', action: { kind: 'open_start', label: 'Open Start' } },
      { title: 'Read the verdict', body: 'Check whether Tuberosa says ready, needs confirmation, or insufficient.' },
      { title: 'Copy the handoff', body: 'Give the handoff to the coding agent before it edits code.' },
    ],
  },
  {
    id: 'missing-context',
    title: 'Fix missing context',
    summary: 'Add missing project knowledge and retry the same task.',
    steps: [
      { title: 'Find the missing signal', body: 'Open the session result and look for files, symbols, docs, or errors under Missing context.' },
      { title: 'Ingest the missing material', body: 'Paste the document or file content into the missing context panel.', action: { kind: 'open_start', label: 'Retry from Start' } },
      { title: 'Retry the task', body: 'Run the same prompt again and compare the verdict.' },
    ],
  },
  {
    id: 'noisy-context',
    title: 'Handle noisy context',
    summary: 'Record selected_but_noisy and use review actions to improve future retrieval.',
    steps: [
      { title: 'Record feedback', body: 'Use selected_but_noisy when useful context appeared with too much unrelated material.' },
      { title: 'Open Review', body: 'Review generated feedback, gaps, or proposals.', action: { kind: 'open_review', label: 'Open Review' } },
    ],
  },
  {
    id: 'review-memory',
    title: 'Review a memory',
    summary: 'Approve, change, or reject lessons before they become trusted memory.',
    steps: [
      { title: 'Open Review', body: 'Filter the decision queue to Drafts.', action: { kind: 'open_review', label: 'Open Review' } },
      { title: 'Check evidence', body: 'Read labels, references, duplicate candidates, and recommendation signals.' },
    ],
  },
  {
    id: 'debugging',
    title: 'Debugging with Tuberosa',
    summary: 'Use errors, files, and symbols as retrieval signals.',
    steps: [
      { title: 'Paste the failure', body: 'Include the exact error and likely file in the Start prompt.' },
      { title: 'Inspect evidence', body: 'Check whether direct error/file evidence outranks generic memory.' },
    ],
  },
  {
    id: 'agent-mcp-examples',
    title: 'Agent/MCP usage examples',
    summary: 'How Codex, Claude, Cursor, or any MCP-aware agent should call Tuberosa.',
    steps: [
      { title: 'Start session', body: 'Call tuberosa_start_session before substantial work.' },
      { title: 'Record decision', body: 'Call tuberosa_record_context_decision before continuing.' },
      { title: 'Finish session', body: 'Call tuberosa_finish_session after meaningful work.' },
    ],
  },
  {
    id: 'cli-api-examples',
    title: 'CLI/API examples',
    summary: 'Terminal and HTTP examples for advanced users.',
    steps: [
      { title: 'Run workbench summary', body: 'Use pnpm run workbench -- --project tuberosa --limit 10.' },
      { title: 'Search context over HTTP', body: 'POST /context/search with prompt, project, files, symbols, and errors.' },
      { title: 'Check system setup', body: 'Use System for store, cache, provider, backup, and API key state.', action: { kind: 'open_system', label: 'Open System' } },
    ],
  },
];

export function listPlaybooks(): Playbook[] {
  return PLAYBOOKS;
}

export function getPlaybook(id: string | undefined): Playbook | undefined {
  if (!id) return PLAYBOOKS[0];
  return PLAYBOOKS.find((playbook) => playbook.id === id);
}
