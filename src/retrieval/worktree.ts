import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { KnowledgeSafetyService } from '../security/knowledge-safety.js';
import type {
  ClassifiedQuery,
  KnowledgeItemType,
  LabelInput,
  ReferenceInput,
  SearchCandidate,
  TaskType,
} from '../types.js';
import { sha256 } from '../util/hash.js';
import { clamp, estimateTokens, uniqueStrings } from '../util/text.js';

/**
 * Phase 5 — Worktree evidence provider.
 *
 * Reads bounded, sanitized live evidence from the on-disk worktree:
 *  - prompt-named files that exist on disk,
 *  - `git status --porcelain` changed/untracked files,
 *  - repo-root `*.md` handoffs (e.g., `handoff.md`, `integrate-reranking.md`),
 *  - recently-edited files within a configurable mtime window.
 *
 * Output mirrors `SearchCandidate` so the worktree slots into fusion as a 6th
 * source without special-casing. Nothing is persisted — the provider is
 * read-through and content is sanitized through the existing
 * `KnowledgeSafetyService` pipeline. Disabled for task types where the live
 * worktree is unlikely to be load-bearing (planning/testing/unknown).
 */

/** Task types where the worktree is the truest evidence for the request. */
const ELIGIBLE_TASK_TYPES = new Set<TaskType>([
  'implementation',
  'debugging',
  'refactor',
  'review',
  'exploration',
]);

/** Reason a worktree file surfaced — used for ranking + traceability. */
export type WorktreeReason =
  | 'prompt_named'
  | 'git_changed'
  | 'root_handoff'
  | 'mtime_recent';

interface SelectedFile {
  abs: string;
  rel: string;
  reason: WorktreeReason;
  stat: Stats;
}

export interface WorktreeProviderOptions {
  enabled: boolean;
  maxFiles: number;
  maxMtimeAgeHours: number;
  maxIngestContentBytes: number;
}

export interface WorktreeSearchInput {
  cwd?: string;
  prompt: string;
  classified: ClassifiedQuery;
  taskType: TaskType;
  project?: string;
  limit: number;
  rejectedKnowledgeIds?: string[];
  now?: Date;
}

export interface WorktreeSearchResult {
  candidates: SearchCandidate[];
  matchedPromptFiles: string[];
  matchScore: number;
  reason?: 'disabled' | 'no_cwd' | 'cwd_missing' | 'ineligible_task' | 'no_files';
}

/** Reason → raw score in (0,1]. Higher = better. Lifted before fusion's source weight. */
const REASON_SCORE: Record<WorktreeReason, number> = {
  prompt_named: 1.0,
  git_changed: 0.85,
  root_handoff: 0.75,
  mtime_recent: 0.6,
};

const HANDOFF_NAME_RE = /(handoff|roadmap|spec|plan|status|notes|integrate|continue)/i;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tiff',
  '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.class', '.jar', '.pyc', '.o', '.a',
]);

const EXCLUDED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.tuberosa',
  '.next',
  '.cache',
  '.idea',
  '.vscode',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  'target',
]);

/** Bounded directories to scan for recently-edited files. Depth 2 from cwd. */
const SHALLOW_SCAN_ROOTS = [
  '', // repo root (depth 1)
  'src',
  'docs',
  'config',
  'implements',
  'scripts',
  'eval',
  'migrations',
];

export class WorktreeProvider {
  constructor(
    private readonly options: WorktreeProviderOptions,
    private readonly safety: KnowledgeSafetyService = new KnowledgeSafetyService(),
  ) {}

  async search(input: WorktreeSearchInput): Promise<WorktreeSearchResult> {
    if (!this.options.enabled) {
      return emptyResult('disabled');
    }
    if (!input.cwd) {
      return emptyResult('no_cwd');
    }
    if (!ELIGIBLE_TASK_TYPES.has(input.taskType)) {
      return emptyResult('ineligible_task');
    }

    const cwd = resolve(input.cwd);
    if (!existsSync(cwd) || !safeStat(cwd)?.isDirectory()) {
      return emptyResult('cwd_missing');
    }

    const promptNamed = uniqueStrings(input.classified.files);
    const selected = this.collectFiles({ cwd, promptNamed, now: input.now ?? new Date() });
    if (selected.length === 0) {
      return emptyResult('no_files');
    }

    const rejectedIds = new Set(input.rejectedKnowledgeIds ?? []);
    const project = input.project ?? input.classified.project ?? 'worktree';
    const sorted = [...selected].sort(compareSelectedForRanking);

    const rawCandidates: SearchCandidate[] = [];
    const matchedPromptFiles = new Set<string>();
    let rank = 0;

    for (const file of sorted) {
      if (rawCandidates.length >= this.options.maxFiles) break;
      const knowledgeId = `worktree:${sha256(file.rel)}`;
      if (rejectedIds.has(knowledgeId)) continue;

      const content = safeReadFile(file.abs, this.options.maxIngestContentBytes);
      if (content === undefined) continue;
      if (isLikelyBinary(file.rel, content)) continue;

      rank += 1;
      const reasonScore = REASON_SCORE[file.reason];
      const promptMatch = matchesPromptFile(file.rel, promptNamed);
      if (promptMatch) {
        matchedPromptFiles.add(promptMatch);
      }

      const candidate: SearchCandidate = {
        knowledgeId,
        chunkId: undefined,
        title: file.rel,
        summary: summaryFor(file),
        content,
        contextualContent: buildContextualContent(file, content),
        itemType: itemTypeFromPath(file.rel),
        project,
        labels: labelsFor(project, file),
        references: referencesFor(file),
        tokenEstimate: estimateTokens(content),
        // Worktree is live truth — high trust by default. Reviewers can downrank via
        // feedback (caught by the existing feedback path).
        trustLevel: 90,
        source: 'worktree',
        rawScore: reasonScore,
        rank,
        freshnessAt: file.stat.mtime.toISOString(),
        createdAt: file.stat.birthtime.toISOString(),
        metadata: {
          worktree: {
            reason: file.reason,
            path: file.rel,
            mtime: file.stat.mtime.toISOString(),
            sizeBytes: content.length,
            promptMatch: Boolean(promptMatch),
          },
        },
      };
      rawCandidates.push(candidate);
    }

    const sanitized = this.safety.sanitizeSearchCandidates(rawCandidates);
    const limited = sanitized.slice(0, Math.max(1, input.limit));

    return {
      candidates: limited,
      matchedPromptFiles: [...matchedPromptFiles],
      matchScore: computeMatchScore(matchedPromptFiles.size, promptNamed.length, limited.length > 0),
    };
  }

  private collectFiles(args: {
    cwd: string;
    promptNamed: string[];
    now: Date;
  }): SelectedFile[] {
    const seen = new Map<string, SelectedFile>();
    const tryAdd = (rel: string, reason: WorktreeReason) => {
      if (!rel) return;
      const normalizedRel = rel.replace(/\\/g, '/');
      if (seen.has(normalizedRel)) return;
      if (seen.size >= this.options.maxFiles) return;
      const abs = resolve(args.cwd, normalizedRel);
      if (!isUnderRoot(abs, args.cwd)) return;
      const stat = safeStat(abs);
      if (!stat || !stat.isFile()) return;
      seen.set(normalizedRel, { abs, rel: normalizedRel, reason, stat });
    };

    // (1) Prompt-named files take precedence — they are the agent's stated focus.
    for (const named of args.promptNamed) {
      if (!named) continue;
      const candidatePaths = candidatePathsForName(named, args.cwd);
      for (const candidate of candidatePaths) {
        if (seen.size >= this.options.maxFiles) break;
        tryAdd(candidate, 'prompt_named');
      }
    }

    // (2) git status --porcelain — uncommitted changes are continuation-state-of-the-art.
    for (const rel of collectGitStatusPaths(args.cwd)) {
      if (seen.size >= this.options.maxFiles) break;
      tryAdd(rel, 'git_changed');
    }

    // (3) Repo-root markdown handoffs.
    for (const rel of collectRootHandoffs(args.cwd)) {
      if (seen.size >= this.options.maxFiles) break;
      tryAdd(rel, 'root_handoff');
    }

    // (4) Recently-edited files within the mtime window.
    const ageCutoffMs = args.now.getTime() - this.options.maxMtimeAgeHours * 3_600_000;
    for (const rel of collectRecentEdits(args.cwd, ageCutoffMs)) {
      if (seen.size >= this.options.maxFiles) break;
      tryAdd(rel, 'mtime_recent');
    }

    return [...seen.values()];
  }
}

function emptyResult(reason: WorktreeSearchResult['reason']): WorktreeSearchResult {
  return { candidates: [], matchedPromptFiles: [], matchScore: 0, reason };
}

function candidatePathsForName(named: string, cwd: string): string[] {
  // Allow a few normalizations: absolute path inside cwd, raw relative, basename match.
  const out: string[] = [];
  if (isAbsolute(named)) {
    const rel = relative(cwd, named);
    if (rel && !rel.startsWith('..')) out.push(rel);
    return out;
  }
  out.push(named);
  // If the prompt named only a basename, try common roots (one cheap shot — git status / mtime scan will catch the rest).
  if (!named.includes('/')) {
    for (const root of ['src', 'docs', 'config', 'implements', 'scripts']) {
      out.push(`${root}/${named}`);
    }
  }
  return out;
}

function collectGitStatusPaths(cwd: string): string[] {
  try {
    const stdout = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      maxBuffer: 512 * 1024,
    });
    const paths: string[] = [];
    for (const line of stdout.split('\n')) {
      if (!line) continue;
      // Format: XY <path>  OR  XY <orig> -> <renamed>
      const trimmed = line.slice(3).trim();
      if (!trimmed) continue;
      const arrow = trimmed.indexOf(' -> ');
      const path = arrow >= 0 ? trimmed.slice(arrow + 4) : trimmed;
      // Strip optional surrounding quotes from `git status` (used for paths with spaces).
      paths.push(stripGitQuoting(path));
    }
    return uniqueStrings(paths);
  } catch {
    return [];
  }
}

function stripGitQuoting(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1);
  }
  return value;
}

function collectRootHandoffs(cwd: string): string[] {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .filter((entry) => HANDOFF_NAME_RE.test(entry.name) || /^[A-Z]/.test(entry.name))
      .map((entry) => entry.name)
      // Deterministic order: handoff-named first, then alphabetic.
      .sort((a, b) => {
        const aMatch = HANDOFF_NAME_RE.test(a) ? 0 : 1;
        const bMatch = HANDOFF_NAME_RE.test(b) ? 0 : 1;
        return aMatch - bMatch || a.localeCompare(b);
      });
  } catch {
    return [];
  }
}

function collectRecentEdits(cwd: string, ageCutoffMs: number): string[] {
  const collected: Array<{ rel: string; mtimeMs: number }> = [];
  for (const root of SHALLOW_SCAN_ROOTS) {
    const absRoot = root ? resolve(cwd, root) : cwd;
    if (!existsSync(absRoot)) continue;
    walkBounded(absRoot, cwd, 2, ageCutoffMs, collected);
  }
  return collected
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.rel.localeCompare(b.rel))
    .map((entry) => entry.rel);
}

function walkBounded(
  dir: string,
  cwd: string,
  remainingDepth: number,
  ageCutoffMs: number,
  out: Array<{ rel: string; mtimeMs: number }>,
): void {
  if (remainingDepth < 0) return;
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>;
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      // Skip hidden files/dirs by default. `.env.example` is sometimes useful; everything
      // else under a dotfile is noise (`.git`, `.tuberosa`, `.vscode`, …).
      if (EXCLUDED_DIR_NAMES.has(entry.name) || entry.isDirectory()) {
        continue;
      }
    }
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkBounded(resolve(dir, entry.name), cwd, remainingDepth - 1, ageCutoffMs, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const abs = resolve(dir, entry.name);
    const stat = safeStat(abs);
    if (!stat) continue;
    if (stat.mtimeMs < ageCutoffMs) continue;
    const rel = relative(cwd, abs).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) continue;
    out.push({ rel, mtimeMs: stat.mtimeMs });
  }
}

function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function safeReadFile(path: string, maxBytes: number): string | undefined {
  try {
    const stat = safeStat(path);
    if (!stat) return undefined;
    if (stat.size > maxBytes) return undefined;
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function isLikelyBinary(rel: string, content: string): boolean {
  const dotIndex = rel.lastIndexOf('.');
  if (dotIndex >= 0) {
    const ext = rel.slice(dotIndex).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return true;
  }
  // Cheap NUL-byte heuristic in the first 1KB.
  const sample = content.slice(0, 1024);
  return sample.includes('\0');
}

function isUnderRoot(abs: string, root: string): boolean {
  const rel = relative(root, abs);
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel);
}

function matchesPromptFile(rel: string, promptFiles: string[]): string | undefined {
  if (promptFiles.length === 0) return undefined;
  const lower = rel.toLowerCase();
  for (const named of promptFiles) {
    const namedLower = named.toLowerCase();
    if (!namedLower) continue;
    if (lower === namedLower || lower.endsWith(`/${namedLower}`) || lower.endsWith(namedLower)) {
      return named;
    }
  }
  return undefined;
}

function computeMatchScore(matched: number, expected: number, anyCandidates: boolean): number {
  if (!anyCandidates) return 0;
  if (expected === 0) return 0;
  return clamp(matched / expected, 0, 1);
}

function compareSelectedForRanking(left: SelectedFile, right: SelectedFile): number {
  const reasonDelta = REASON_SCORE[right.reason] - REASON_SCORE[left.reason];
  if (reasonDelta !== 0) return reasonDelta;
  // Newer mtime first → continuation-relevant.
  const mtimeDelta = right.stat.mtimeMs - left.stat.mtimeMs;
  if (mtimeDelta !== 0) return mtimeDelta;
  return left.rel.localeCompare(right.rel);
}

function itemTypeFromPath(path: string): KnowledgeItemType {
  const lower = path.toLowerCase();
  if (lower.endsWith('.md')) {
    if (lower.includes('spec') || lower.includes('plan') || lower.includes('roadmap')) {
      return 'spec';
    }
    if (lower.includes('handoff')) {
      return 'workflow';
    }
    return 'wiki';
  }
  return 'code_ref';
}

function labelsFor(project: string, file: SelectedFile): LabelInput[] {
  const labels: LabelInput[] = [
    { type: 'project', value: project, weight: 1 },
    { type: 'file', value: file.rel, weight: 1 },
  ];
  if (file.reason === 'prompt_named') {
    labels.push({ type: 'task_type', value: 'continuation', weight: 0.8 });
  }
  return labels;
}

function referencesFor(file: SelectedFile): ReferenceInput[] {
  return [
    {
      type: 'file',
      uri: file.rel,
      metadata: { worktreeReason: file.reason },
    },
  ];
}

function summaryFor(file: SelectedFile): string {
  switch (file.reason) {
    case 'prompt_named':
      return `Worktree file the prompt named (${file.rel}). Mtime ${file.stat.mtime.toISOString()}.`;
    case 'git_changed':
      return `Worktree file with uncommitted changes (${file.rel}). Mtime ${file.stat.mtime.toISOString()}.`;
    case 'root_handoff':
      return `Repo-root handoff/spec document (${file.rel}). Mtime ${file.stat.mtime.toISOString()}.`;
    case 'mtime_recent':
      return `Recently-edited worktree file (${file.rel}). Mtime ${file.stat.mtime.toISOString()}.`;
  }
}

function buildContextualContent(file: SelectedFile, content: string): string {
  const header = [
    `Worktree source: ${file.reason}`,
    `Path: ${file.rel}`,
    `Mtime: ${file.stat.mtime.toISOString()}`,
  ].join('\n');
  return `${header}\n\n${content}`;
}
