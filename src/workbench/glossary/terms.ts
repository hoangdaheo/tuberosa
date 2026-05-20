export type TermKey =
  | 'context_broker'
  | 'context_pack'
  | 'context_fit'
  | 'knowledge_item'
  | 'knowledge_chunk'
  | 'memory'
  | 'reflection_draft'
  | 'learning_gate'
  | 'learning_signal'
  | 'learning_proposal'
  | 'knowledge_gap'
  | 'classify'
  | 'fts'
  | 'pgvector'
  | 'rrf'
  | 'rerank'
  | 'intent_suppression'
  | 'essential_section'
  | 'supporting_section'
  | 'optional_section'
  | 'deep_context'
  | 'orientation'
  | 'task_brief'
  | 'label'
  | 'reference'
  | 'knowledge_relation'
  | 'atomizer'
  | 'physical_mirror'
  | 'freshness'
  | 'agent_session'
  | 'context_decision'
  | 'stale'
  | 'superseded'
  | 'trust_level'
  | 'evidence_strength'
  | 'error_log'
  | 'workbench'
  | 'duplicate_candidate'
  | 'grounded_reference';

export interface GlossaryTerm {
  label: string;
  short: string;
  long: string;
  example?: string;
  seeAlso?: TermKey[];
  category: 'core' | 'retrieval' | 'pack' | 'storage' | 'session' | 'review' | 'ops';
}

export const TERMS: Record<TermKey, GlossaryTerm> = {
  context_broker: {
    label: 'Context broker',
    category: 'core',
    short: 'A service that finds and ranks relevant project knowledge for coding agents.',
    long: 'Tuberosa is a context broker. When an AI coding agent starts a task, the broker matches the prompt to stored project knowledge (specs, code, lessons) and hands back a ranked, budget-aware package so the agent does not have to rediscover everything from scratch.',
  },
  context_pack: {
    label: 'Context pack',
    category: 'pack',
    short: 'A ranked, budget-aware bundle of knowledge handed to an agent for one task.',
    long: 'A context pack is the unit Tuberosa returns from a search. It contains essential, supporting, and optional sections of ranked knowledge items, plus orientation (task brief, verification commands) and a context-fit verdict (ready / needs confirmation / insufficient).',
    seeAlso: ['essential_section', 'context_fit', 'task_brief'],
  },
  context_fit: {
    label: 'Context fit',
    category: 'pack',
    short: 'A verdict on whether the retrieved knowledge actually addresses the task.',
    long: 'After fusion and reranking, Tuberosa evaluates whether the top candidates actually cover the request. It emits "ready" (good to proceed), "needs_confirmation" (review first), or "insufficient" (ask for more signal). The verdict drives agent policy.',
    example: 'A fit status of "insufficient" means the agent should ask the user for missing files or symbols before continuing.',
  },
  knowledge_item: {
    label: 'Knowledge item',
    category: 'storage',
    short: 'One stored unit of project knowledge — a spec, lesson, code reference, or note.',
    long: 'Every searchable thing in Tuberosa is a knowledge item. It has a title, summary, content, labels, references, a trust level, freshness timestamp, and an item type (spec, workflow, memory, bugfix, code_ref, rule, wiki, conversation).',
    seeAlso: ['label', 'reference', 'trust_level', 'freshness'],
  },
  knowledge_chunk: {
    label: 'Knowledge chunk',
    category: 'storage',
    short: 'A subdivision of a knowledge item used for vector search.',
    long: 'Large knowledge items are split into chunks before embedding. Each chunk gets its own vector. The chunk content is stored alongside contextual text so search can highlight the right portion.',
  },
  memory: {
    label: 'Memory',
    category: 'review',
    short: 'An approved reflection — a lesson that becomes searchable knowledge.',
    long: 'Memories are durable lessons. They start life as reflection drafts and become memories only after they pass the learning gate (auto-approval) or human review in the workbench.',
    seeAlso: ['reflection_draft', 'learning_gate'],
  },
  reflection_draft: {
    label: 'Reflection draft',
    category: 'review',
    short: 'A proposed lesson awaiting approval, rejection, or revision.',
    long: 'When an agent finishes a task, Tuberosa may propose a reflection draft summarising the lesson. Drafts have status pending, approved, rejected, or needs_changes. They carry suggested labels, references, duplicate candidates, and trigger metadata.',
    seeAlso: ['memory', 'learning_gate'],
  },
  learning_gate: {
    label: 'Learning gate',
    category: 'review',
    short: 'The 11 safety checks a draft must pass to auto-approve into memory.',
    long: 'Auto-approval requires every gate to pass: learning mode is on, the session completed, context coverage and fit were healthy, no negative or noisy feedback, signals are confident, no duplicates exist, references are grounded, labels are concrete, and the draft is substantive enough.',
    example: 'A draft with one similar memory already approved is held for review instead of auto-approving — to prevent duplicates.',
    seeAlso: ['reflection_draft', 'duplicate_candidate', 'grounded_reference'],
  },
  learning_signal: {
    label: 'Learning signal',
    category: 'session',
    short: 'A structured nugget — tip, decision, mistake, verification — captured during a session.',
    long: 'Agents emit learning signals while working: "tip: prefer X", "mistake: avoid Y", "verification: run Z". Signals have a confidence score; low-confidence signals block auto-approval.',
  },
  learning_proposal: {
    label: 'Learning proposal',
    category: 'review',
    short: 'A reviewable suggestion to clean up the knowledge base.',
    long: 'Proposals are generated from feedback signals. They suggest supersession, missing labels, missing references, missing relations, or auto-memory cleanup. A human reviews them in the workbench.',
  },
  knowledge_gap: {
    label: 'Knowledge gap',
    category: 'review',
    short: 'A hole in the knowledge base inferred from missing-context feedback.',
    long: 'When an agent reports that crucial context was missing (no relevant file, symbol, or doc was retrievable), Tuberosa records it as a knowledge gap so a human can decide whether to ingest the missing material.',
  },
  classify: {
    label: 'Classify',
    category: 'retrieval',
    short: 'Step 1: parse the prompt into task type, files, symbols, errors, technologies.',
    long: 'Classification turns a free-text prompt into structured signals (task type, target files, symbols, errors, technologies, business areas) that drive the rest of the retrieval pipeline.',
  },
  fts: {
    label: 'FTS (full-text search)',
    category: 'retrieval',
    short: 'Postgres lexical search — matches exact words against indexed content.',
    long: 'FTS finds candidates whose content contains the search terms verbatim. It complements vector search by catching exact technical names, error codes, and acronyms that embeddings sometimes fuzz over.',
  },
  pgvector: {
    label: 'pgvector',
    category: 'retrieval',
    short: 'Postgres extension that stores embeddings and runs semantic similarity search.',
    long: 'Each knowledge chunk has a vector embedding. pgvector indexes those vectors so a query embedding can quickly find conceptually similar chunks, even when the words do not match.',
  },
  rrf: {
    label: 'Reciprocal rank fusion (RRF)',
    category: 'retrieval',
    short: 'A formula for combining multiple ranked candidate lists into one.',
    long: 'After running metadata, FTS, vector, memory, and graph searches in parallel, Tuberosa fuses their result lists with reciprocal rank fusion — each result is scored by 1 / (k + rank). Items that appear high across multiple sources rise to the top.',
  },
  rerank: {
    label: 'Rerank',
    category: 'retrieval',
    short: 'A second-pass ranking that reorders the top candidates after fusion.',
    long: 'After fusion produces a top-N shortlist, a reranker (deterministic hash for tests, OpenAI structured-output reranker in production) reorders them based on a deeper match assessment.',
  },
  intent_suppression: {
    label: 'Intent suppression',
    category: 'retrieval',
    short: 'A penalty applied to candidates flagged as stale, superseded, or evidence-mismatched.',
    long: 'After fusion and rerank, Tuberosa subtracts score from candidates that prior feedback marked as stale, that a newer item supersedes, or that do not actually evidence the task. The penalty keeps deprecated lessons from outranking current ones.',
    seeAlso: ['stale', 'superseded'],
  },
  essential_section: {
    label: 'Essential section',
    category: 'pack',
    short: 'The must-read 50% of a context pack — the most directly task-relevant items.',
    long: 'A context pack is split into three budgets: essential (50%), supporting (30%), optional (20%). The essential section carries the items most directly addressing the prompt and is the first thing an agent should read.',
  },
  supporting_section: {
    label: 'Supporting section',
    category: 'pack',
    short: 'The 30% of a context pack with related but secondary material.',
    long: 'Supporting items provide useful surrounding context — adjacent docs, related workflows, neighbouring code — without being the headline answer to the task.',
  },
  optional_section: {
    label: 'Optional section',
    category: 'pack',
    short: 'The 20% of a context pack with adjacent or lower-confidence material.',
    long: 'Optional items are loosely related — read them only if the essential and supporting sections do not already answer the question.',
  },
  deep_context: {
    label: 'Deep context',
    category: 'pack',
    short: 'A full-text expansion of selected items, up to a separate token budget.',
    long: 'In layered mode, the pack returns summaries; if the agent wants the full content of selected knowledge IDs, deep context expands those chunks up to the deep budget (around 60k tokens by default).',
  },
  orientation: {
    label: 'Orientation',
    category: 'pack',
    short: 'Startup guidance shipped with a context pack: inferred task, recommended files, commands.',
    long: 'Orientation tells the agent where to start: the inferred task, recommended files to read first, likely UI/code surfaces, verification commands to run, and any missing signals the user should clarify.',
  },
  task_brief: {
    label: 'Task brief',
    category: 'pack',
    short: 'A prioritised checklist of actions the agent should take next.',
    long: 'The task brief sits at the top of a pack. It lists actions in priority order with links to evidence, review targets (drafts, gaps), files to read, and verification commands.',
  },
  label: {
    label: 'Label',
    category: 'storage',
    short: 'A normalised metadata tag on a knowledge item (file, symbol, error, technology…).',
    long: 'Labels are typed key-value tags with a weight. Types include project, repo, file, symbol, error, technology, business_area, task_type, user_preference. Concrete labels make a knowledge item findable by future tasks.',
  },
  reference: {
    label: 'Reference',
    category: 'storage',
    short: 'A pointer to a source: file path, URL, commit, tool, or conversation.',
    long: 'References ground a knowledge item in real artefacts. A draft with only conversation references is unverifiable; one citing a file or commit is much stronger.',
    seeAlso: ['grounded_reference'],
  },
  knowledge_relation: {
    label: 'Knowledge relation',
    category: 'storage',
    short: 'A directed link between two knowledge items — contains, references, supersedes, etc.',
    long: 'Knowledge relations express how items connect: contains, references, mentions, resolves, supersedes, depends_on, derived_from_session, related_to. The graph powers expansion during retrieval.',
  },
  atomizer: {
    label: 'Atomizer',
    category: 'storage',
    short: 'A pre-processor that splits large Markdown into one-section-per-item atoms.',
    long: 'Long docs and specs are atomized into independent knowledge items at heading boundaries before chunking. That makes each idea independently retrievable and the line ranges accurate.',
  },
  physical_mirror: {
    label: 'Physical mirror',
    category: 'ops',
    short: 'A human-readable .tuberosa/current/ folder synced from the database.',
    long: 'When enabled, every database write is debounced and mirrored to .tuberosa/current/ as .md and .jsonl files. Useful for grep, diff, git, and reviewing what is actually stored.',
  },
  freshness: {
    label: 'Freshness',
    category: 'storage',
    short: 'A timestamp on a knowledge item that signals staleness risk.',
    long: 'Freshness is a soft signal of "how current is this?". The retrieval pipeline factors freshness into stale risk and may penalise old items if newer evidence exists.',
  },
  agent_session: {
    label: 'Agent session',
    category: 'session',
    short: 'The audit record of one agent task: prompt, context, decisions, outcome.',
    long: 'Each agent task can start a session. It stores the initial pack, every context decision the agent made, learning signals, the outcome (completed, failed, blocked, cancelled), and the resulting reflection draft.',
    seeAlso: ['context_decision', 'reflection_draft'],
  },
  context_decision: {
    label: 'Context decision',
    category: 'session',
    short: "A record of how the agent rated the suggested context (selected, rejected, stale…).",
    long: 'Each decision the agent makes — selected, selected_but_noisy, rejected, stale, irrelevant, missing_context, too_much_adjacent_context — is logged so future retrievals can learn from it.',
  },
  stale: {
    label: 'Stale',
    category: 'review',
    short: 'A feedback marker indicating an item is outdated; the broker penalises it later.',
    long: 'When an agent or human marks an item stale, future searches penalise it and similar items via intent suppression. Use it for deprecated APIs, removed code paths, or obsolete decisions.',
  },
  superseded: {
    label: 'Superseded',
    category: 'review',
    short: 'A relation meaning one knowledge item replaces another.',
    long: 'Marking item A as superseded by item B tells Tuberosa to demote A and surface B instead. It is the cleanest way to roll forward a lesson without losing history.',
  },
  trust_level: {
    label: 'Trust level',
    category: 'storage',
    short: 'A 0–100 score of how reliable a knowledge item is.',
    long: 'Trust level boosts (or demotes) an item during scoring. Approved reflections start at 85. Imported docs and code refs may start higher or lower depending on origin.',
  },
  evidence_strength: {
    label: 'Evidence strength',
    category: 'pack',
    short: 'A grade — strong, moderate, weak — for how directly a candidate evidences the task.',
    long: 'Beyond the score, each candidate gets an evidence strength rating. Strong evidence directly mentions the task files/symbols/errors. Moderate is adjacent. Weak is loosely related.',
  },
  error_log: {
    label: 'Error log',
    category: 'ops',
    short: 'A sanitised journal of failures — agent, MCP, HTTP, retrieval, database, ingestion.',
    long: 'Error logs are stored as JSON + Markdown on disk and grouped by project, category, and month. Repeated failures share a fingerprint so duplicates collapse into one entry with an occurrence count.',
  },
  workbench: {
    label: 'Workbench',
    category: 'ops',
    short: 'This web UI — for reviewing drafts, error logs, gaps, and proposals.',
    long: 'The workbench is where humans review what Tuberosa wants to learn. Pending drafts, knowledge gaps, learning proposals, error logs, risky auto-memories, and conflicts all surface here.',
  },
  duplicate_candidate: {
    label: 'Duplicate candidate',
    category: 'review',
    short: 'A previously-approved memory similar enough to a draft that approval would create overlap.',
    long: 'Before a draft is approved, Tuberosa searches memory for similar items. Any matches are listed as duplicate candidates. If any exist, the learning gate blocks auto-approval and asks a human to merge or supersede instead.',
  },
  grounded_reference: {
    label: 'Grounded reference',
    category: 'review',
    short: 'A non-conversation reference — file, URL, or commit — that verifies the lesson.',
    long: 'A draft with only conversation references cannot be cross-checked. A grounded reference (file:src/foo.ts, commit:abc123, url:…) points at a verifiable source. The learning gate requires at least one.',
  },
};

export function termKeys(): TermKey[] {
  return Object.keys(TERMS) as TermKey[];
}

export function categoryOrder(): GlossaryTerm['category'][] {
  return ['core', 'retrieval', 'pack', 'storage', 'session', 'review', 'ops'];
}

export function categoryLabel(category: GlossaryTerm['category']): string {
  switch (category) {
    case 'core': return 'Core concepts';
    case 'retrieval': return 'Retrieval pipeline';
    case 'pack': return 'Context pack';
    case 'storage': return 'Storage & metadata';
    case 'session': return 'Agent sessions';
    case 'review': return 'Review & learning';
    case 'ops': return 'Operations';
  }
}
