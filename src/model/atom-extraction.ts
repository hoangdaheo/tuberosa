import { ModelProviderError } from '../errors.js';
import { clamp, truncate } from '../util/text.js';
import type { ExtractedAtomCandidate } from './provider.js';

/**
 * SP2 — single source of truth for atom-extraction and atom-utility LLM
 * calls. Both OpenAiModelProvider (/v1/responses) and OllamaGenerationProvider
 * (/api/chat) use the same prompts, schemas, and parsers so atom quality
 * semantics never drift between providers; only the transport differs.
 */

const MAX_ATOMS = 8;
const MAX_CLAIM_LENGTH = 240; // matches the critic floor (src/atoms/critic.ts)
const ATOM_TYPES = ['fact', 'procedure', 'decision', 'gotcha', 'convention'] as const;

export const ATOM_EXTRACTION_SYSTEM_PROMPT = [
  'You extract reusable engineering lessons ("atoms") from a finished coding-agent session.',
  `Return at most ${MAX_ATOMS} atoms. Fewer, higher-value atoms beat many weak ones.`,
  'Return an empty list when the session contains nothing generalizable.',
  'Each atom must be a lesson a FUTURE agent can apply to a similar but different task —',
  'not a status update, not a restatement of the session prompt, not one-time trivia.',
  `claim: one concrete, self-contained sentence, max ${MAX_CLAIM_LENGTH} characters.`,
  'type: fact | procedure | decision | gotcha | convention.',
  'evidence: at least one concrete reference (file path, commit sha, test, url, or prior session).',
  'trigger: signals that should surface this atom later (errors, files, symbols, taskTypes, intentTags).',
  'verification: optional command or assertion that proves the claim still holds.',
  'pitfalls: optional list of mistakes to avoid.',
  'Preserve exact file paths, symbols, and error tokens verbatim.',
  'Return JSON only.',
].join(' ');

export const ATOM_UTILITY_SYSTEM_PROMPT = [
  'You audit a candidate engineering lesson for a coding-agent memory.',
  'Decide if it is generalizable — i.e. would help a future agent on a similar but different task.',
  'Reject if it merely describes one-time events (test runs, commits, status updates) or restates trivia.',
  'Return JSON only: { "generalizable": bool, "reason": string, "confidence": 0..1 }.',
].join(' ');

/**
 * Root is an object (not a bare array): OpenAI strict mode and Ollama's
 * `format` both require an object root. Optional fields are nullable +
 * required, which is what OpenAI strict mode demands; the parser strips nulls.
 */
export function atomExtractionSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      atoms: {
        type: 'array',
        maxItems: MAX_ATOMS,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            claim: { type: 'string' },
            type: { type: 'string', enum: [...ATOM_TYPES] },
            evidence: {
              type: 'array',
              maxItems: 6,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['file', 'commit', 'test', 'url', 'prior_session'] },
                  path: { type: ['string', 'null'] },
                  sha: { type: ['string', 'null'] },
                  uri: { type: ['string', 'null'] },
                  testName: { type: ['string', 'null'] },
                  sessionId: { type: ['string', 'null'] },
                },
                required: ['kind', 'path', 'sha', 'uri', 'testName', 'sessionId'],
              },
            },
            trigger: {
              type: 'object',
              additionalProperties: false,
              properties: {
                errors: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 6 },
                files: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 6 },
                symbols: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 6 },
                taskTypes: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 4 },
                intentTags: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 4 },
              },
              required: ['errors', 'files', 'symbols', 'taskTypes', 'intentTags'],
            },
            verification: {
              type: ['object', 'null'],
              additionalProperties: false,
              properties: {
                command: { type: ['string', 'null'] },
                assertion: { type: ['string', 'null'] },
              },
              required: ['command', 'assertion'],
            },
            pitfalls: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 6 },
          },
          required: ['claim', 'type', 'evidence', 'trigger', 'verification', 'pitfalls'],
        },
      },
    },
    required: ['atoms'],
  };
}

export function atomUtilitySchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      generalizable: { type: 'boolean' },
      reason: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['generalizable', 'reason', 'confidence'],
  };
}

/**
 * Parses + normalizes a model response into ExtractedAtomCandidate[].
 * Invalid entries are dropped individually (a partially-bad batch still
 * yields its good atoms). Policy checks (evidence required, triviality,
 * dedup) belong to the AtomCritic, not here — shape only.
 */
export function parseExtractedAtoms(text: string): ExtractedAtomCandidate[] {
  const parsed = parseJsonObject(text, 'Atom extraction response');
  const entries = Array.isArray(parsed.atoms) ? parsed.atoms : [];
  const atoms: ExtractedAtomCandidate[] = [];
  for (const entry of entries) {
    if (atoms.length >= MAX_ATOMS) break;
    const atom = normalizeAtom(entry);
    if (atom) atoms.push(atom);
  }
  return atoms;
}

export function parseAtomUtilityVerdict(
  text: string,
): { generalizable: boolean; reason: string; confidence: number } {
  const parsed = parseJsonObject(text, 'Atom utility response');
  return {
    generalizable: parsed.generalizable === true,
    reason: typeof parsed.reason === 'string' ? truncate(parsed.reason, 200) : '',
    confidence: typeof parsed.confidence === 'number' ? clamp(parsed.confidence, 0, 1) : 0,
  };
}

function normalizeAtom(entry: unknown): ExtractedAtomCandidate | undefined {
  if (!isRecord(entry)) return undefined;
  const claim = typeof entry.claim === 'string' ? truncate(entry.claim, MAX_CLAIM_LENGTH).trim() : '';
  if (!claim) return undefined;
  const type = ATOM_TYPES.find((t) => t === entry.type);
  if (!type) return undefined;

  const atom: ExtractedAtomCandidate = {
    claim,
    type,
    evidence: normalizeEvidence(entry.evidence),
    trigger: normalizeTrigger(entry.trigger),
  };
  const verification = normalizeVerification(entry.verification);
  if (verification) atom.verification = verification;
  const pitfalls = stringArray(entry.pitfalls, 6);
  if (pitfalls.length > 0) atom.pitfalls = pitfalls;
  return atom;
}

function normalizeEvidence(value: unknown): ExtractedAtomCandidate['evidence'] {
  if (!Array.isArray(value)) return [];
  const evidence: ExtractedAtomCandidate['evidence'] = [];
  for (const entry of value.slice(0, 6)) {
    if (!isRecord(entry)) continue;
    if (entry.kind === 'file' && typeof entry.path === 'string' && entry.path.trim()) {
      evidence.push({ kind: 'file', path: entry.path.trim() });
    } else if (entry.kind === 'commit' && typeof entry.sha === 'string' && entry.sha.trim()) {
      evidence.push({ kind: 'commit', sha: entry.sha.trim() });
    } else if (
      entry.kind === 'test'
      && typeof entry.path === 'string' && entry.path.trim()
      && typeof entry.testName === 'string' && entry.testName.trim()
    ) {
      evidence.push({ kind: 'test', path: entry.path.trim(), testName: entry.testName.trim() });
    } else if (entry.kind === 'url' && typeof entry.uri === 'string' && entry.uri.trim()) {
      evidence.push({ kind: 'url', uri: entry.uri.trim(), fetchedAt: new Date().toISOString() });
    } else if (entry.kind === 'prior_session' && typeof entry.sessionId === 'string' && entry.sessionId.trim()) {
      evidence.push({ kind: 'prior_session', sessionId: entry.sessionId.trim() });
    }
  }
  return evidence;
}

function normalizeTrigger(value: unknown): ExtractedAtomCandidate['trigger'] {
  if (!isRecord(value)) return {};
  const trigger: ExtractedAtomCandidate['trigger'] = {};
  const errors = stringArray(value.errors, 6);
  const files = stringArray(value.files, 6);
  const symbols = stringArray(value.symbols, 6);
  const taskTypes = stringArray(value.taskTypes, 4);
  const intentTags = stringArray(value.intentTags, 4);
  if (errors.length) trigger.errors = errors;
  if (files.length) trigger.files = files;
  if (symbols.length) trigger.symbols = symbols;
  if (taskTypes.length) trigger.taskTypes = taskTypes;
  if (intentTags.length) trigger.intentTags = intentTags;
  return trigger;
}

function normalizeVerification(value: unknown): ExtractedAtomCandidate['verification'] | undefined {
  if (!isRecord(value)) return undefined;
  const verification: NonNullable<ExtractedAtomCandidate['verification']> = {};
  if (typeof value.command === 'string' && value.command.trim()) verification.command = truncate(value.command, 300).trim();
  if (typeof value.assertion === 'string' && value.assertion.trim()) verification.assertion = truncate(value.assertion, 300).trim();
  return verification.command || verification.assertion ? verification : undefined;
}

function stringArray(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => truncate(item, 200).trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseJsonObject(value: string, description: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new ModelProviderError(`${description} was not a JSON object.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
