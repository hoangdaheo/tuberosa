import type { FilterEvent, KnowledgeInput, RankedCandidate, ReflectionDraftInput, SearchCandidate } from '../types.js';
import { SafetyBlockedError } from '../errors.js';
import { getRetrievalPolicy, type RetrievalPolicy } from '../retrieval/policy.js';

export interface SafetySanitizeOptions {
  onFilterEvent?: (event: FilterEvent) => void;
}

export interface SuspiciousContentClassification {
  issues: KnowledgeSafetyIssue[];
}

export interface SuspiciousContentClassifier {
  readonly name: string;
  classify(text: string): SuspiciousContentClassification;
}

export interface KnowledgeSafetyServiceOptions {
  classifier?: SuspiciousContentClassifier;
  policyAccessor?: () => RetrievalPolicy;
}

export type KnowledgeSafetyStatus = 'safe' | 'suspicious' | 'blocked';
export type KnowledgeSafetyIssueType = 'secret' | 'prompt_injection' | 'malware_indicator';
export type KnowledgeSafetySeverity = 'low' | 'medium' | 'high';

export interface KnowledgeSafetyIssue {
  type: KnowledgeSafetyIssueType;
  severity: KnowledgeSafetySeverity;
  message: string;
  redacted?: boolean;
}

export interface KnowledgeSafetyMetadata {
  status: KnowledgeSafetyStatus;
  injectable: boolean;
  issues: KnowledgeSafetyIssue[];
  redactionCount: number;
  checkedAt: string;
}

interface TextScanResult {
  text: string;
  issues: KnowledgeSafetyIssue[];
  redactionCount: number;
  /** Phase 9 — names of patterns that actually fired (validator-approved). */
  firedPatterns: string[];
}

/** Phase 9 — public summary of a single secret-pattern scan, used by eval:safety. */
export interface SecretScanResult {
  redactedText: string;
  redactionCount: number;
  firedPatterns: string[];
  perPattern: Record<string, number>;
}

export const SECRET_PATTERN_NAMES: readonly string[] = [
  'pem_private_key',
  'openai_api_key',
  'github_token',
  'aws_access_key',
  'credential_assignment',
];

interface SafetyDecision {
  status: KnowledgeSafetyStatus;
  injectable: boolean;
  issues: KnowledgeSafetyIssue[];
  redactionCount: number;
}

/**
 * Phase 9 — context passed to per-pattern validators. Allows skipping a regex
 * match when it lands inside a comment, a TypeScript type annotation, an env
 * placeholder, or any other surface that the lab fixture says should NOT redact.
 */
export interface SecretPatternValidatorContext {
  fullMatch: string;
  value: string;
  matchIndex: number;
  fullText: string;
}

interface TextPattern {
  /** Phase 9 — short stable identifier used by the safety evaluator. */
  name?: string;
  pattern: RegExp;
  issue: KnowledgeSafetyIssue;
  /**
   * Phase 9 — return true to keep the redaction, false to skip and leave the
   * original text intact. Receives the full match and the captured value group
   * named `value` (or the full match when no group is present).
   */
  validator?: (context: SecretPatternValidatorContext) => boolean;
}

const SECRET_PATTERNS: TextPattern[] = [
  {
    name: 'pem_private_key',
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    issue: { type: 'secret', severity: 'high', message: 'Private key material was redacted.', redacted: true },
  },
  {
    name: 'openai_api_key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'OpenAI-style API key was redacted.', redacted: true },
  },
  {
    name: 'github_token',
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'GitHub token was redacted.', redacted: true },
  },
  {
    name: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'AWS access key id was redacted.', redacted: true },
  },
  {
    name: 'credential_assignment',
    // Phase 9 — keyword may be quoted (JSON-style "password": "..."), and the
    // value is captured into a named group so the validator can vet it.
    pattern: /(?:api[_-]?key|secret|token|password|passwd|pwd|bearer|client[_-]?secret|private[_-]?key|access[_-]?key|service[_-]?account|connection[_-]?string|dsn|webhook[_-]?url|auth)["']?\s*[:=]\s*["']?(?<value>[^"'\s]{12,})["']?/gi,
    issue: { type: 'secret', severity: 'medium', message: 'Credential-like assignment was redacted.', redacted: true },
    validator: (ctx) => !isCredentialAssignmentFalsePositive(ctx),
  },
  {
    name: 'github_pat_fine_grained',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'GitHub fine-grained PAT was redacted.', redacted: true },
  },
  {
    name: 'anthropic_api_key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'Anthropic API key was redacted.', redacted: true },
  },
  {
    name: 'google_api_key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'Google API key was redacted.', redacted: true },
  },
  {
    name: 'slack_token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'Slack token was redacted.', redacted: true },
  },
  {
    name: 'slack_app_token',
    pattern: /\bxapp-[0-9]-[A-Za-z0-9-]{10,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'Slack app token was redacted.', redacted: true },
  },
  {
    name: 'stripe_live_secret',
    pattern: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'Stripe live key was redacted.', redacted: true },
  },
  {
    name: 'sendgrid_api_key',
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'SendGrid API key was redacted.', redacted: true },
  },
  {
    name: 'twilio_account_sid',
    pattern: /\bAC[0-9a-f]{32}\b/g,
    issue: { type: 'secret', severity: 'medium', message: 'Twilio account SID was redacted.', redacted: true },
  },
  {
    name: 'mailgun_api_key',
    pattern: /\bkey-[0-9a-f]{32}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'Mailgun API key was redacted.', redacted: true },
  },
  {
    name: 'npm_token',
    pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'npm token was redacted.', redacted: true },
  },
  {
    name: 'huggingface_token',
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'HuggingFace token was redacted.', redacted: true },
  },
  {
    name: 'aws_session_key_id',
    pattern: /\b(?:ASIA|AGPA|AROA|AIDA|ANPA|ANVA)[0-9A-Z]{16}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'AWS session/identifier key was redacted.', redacted: true },
  },
  {
    name: 'jwt_token',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'JWT was redacted.', redacted: true },
  },
  {
    name: 'azure_storage_connection_string',
    pattern: /\bDefaultEndpointsProtocol=https?;AccountName=[A-Za-z0-9]+;AccountKey=[A-Za-z0-9+/=]+(?:;[A-Za-z0-9=.]+)*\b/g,
    issue: { type: 'secret', severity: 'high', message: 'Azure storage connection string was redacted.', redacted: true },
  },
  {
    name: 'gcp_service_account_email',
    pattern: /\b[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.iam\.gserviceaccount\.com\b/g,
    issue: { type: 'secret', severity: 'medium', message: 'GCP service account identifier was redacted.', redacted: true },
  },
  {
    name: 'bearer_token_in_url_or_header',
    pattern: /\b(?:Bearer|authorization|access_token)["']?\s*[:=]\s*["']?[A-Za-z0-9_.~+/-]{20,}={0,2}\b/gi,
    issue: { type: 'secret', severity: 'high', message: 'Bearer/authorization token was redacted.', redacted: true },
  },
];

const PLACEHOLDER_REGEXES: readonly RegExp[] = [
  /^[<{][^>}]*[>}]$/,                                // <foo>, {foo}
  /^\$\{[^}]*\}$/,                                   // ${foo}
  /^\{\{[^}]*\}\}$/,                                 // {{foo}}
  /^(?:your[_-]|test[_-]|dummy[_-]|example[_-]|sample[_-]|fake[_-])/i,
  /(?:[_-](?:here|placeholder|example|sample|fake|dummy|replace[_-]?me))(?:[_-][a-z0-9]+)?$/i,
  /^x{8,}$|^\.{8,}$|^-{8,}$|^\*{8,}$/i,              // xxxxxxxx, ........, --------
  // Common env-var NAMES only (short, descriptive). Long SHELL_STYLE_VALUES with
  // digits or many segments may be real secrets, so we leave those to be
  // redacted. Heuristic: short (<24 chars) all-uppercase tokens with at most 3
  // segments and no digit groups longer than 2 chars.
  /^[A-Z]{1,12}(?:_[A-Z]{1,12}){0,2}$/,
  /^\.\.\.$/,
];

function isLikelyPlaceholder(rawValue: string): boolean {
  const value = rawValue.replace(/^["']|["']$/g, '').trim();
  if (value.length === 0) return true;
  return PLACEHOLDER_REGEXES.some((re) => re.test(value));
}

function looksLikeTypeAnnotation(rawValue: string): boolean {
  // Strip surrounding quotes and *trailing* code punctuation that the value
  // regex happily slurps up (`,`, `;`, `)`, `]`, `}`, `>`). Identifier itself
  // never contains those, so removing them is safe.
  const value = rawValue
    .replace(/^["']|["']$/g, '')
    .replace(/[,;:)}\]>]+$/g, '')
    .trim();
  if (value.length === 0) return false;
  // PascalCase identifier (or dotted chain) with no digits/punctuation — looks
  // like a TypeScript type, not a credential.
  return /^(?:[A-Z][A-Za-z]*)(?:\.[A-Z][A-Za-z]*)*$/.test(value);
}

function isLowEntropy(rawValue: string): boolean {
  const value = rawValue.replace(/^["']|["']$/g, '');
  if (value.length === 0) return true;
  return new Set(value).size <= 3;
}

function isCommentContext(fullText: string, matchIndex: number): boolean {
  const lineStart = fullText.lastIndexOf('\n', matchIndex - 1) + 1;
  const linePrefix = fullText.slice(lineStart, matchIndex);
  const trimmed = linePrefix.replace(/^\s+/, '');
  if (trimmed.startsWith('//') || trimmed.startsWith('#')) return true;
  // JSDoc / block-comment continuation lines (e.g. ` * @param ...`).
  if (/^\*\s/.test(trimmed) || trimmed === '*') return true;
  if (trimmed.startsWith('/*')) return true;
  return false;
}

function isCredentialAssignmentFalsePositive(ctx: SecretPatternValidatorContext): boolean {
  if (isCommentContext(ctx.fullText, ctx.matchIndex)) return true;
  const value = ctx.value;
  if (isLikelyPlaceholder(value)) return true;
  if (looksLikeTypeAnnotation(value)) return true;
  if (isLowEntropy(value)) return true;
  return false;
}

const BLOCK_PATTERNS: TextPattern[] = [
  {
    pattern: /\bignore\s+(?:all\s+)?(?:previous|above|prior)\s+(?:instructions|rules|messages)\b/i,
    issue: { type: 'prompt_injection', severity: 'high', message: 'Prompt-injection instruction tried to override prior instructions.' },
  },
  {
    pattern: /\b(?:reveal|print|dump|show|send)\s+(?:the\s+)?(?:system|developer)\s+(?:prompt|message|instructions)\b/i,
    issue: { type: 'prompt_injection', severity: 'high', message: 'Prompt-injection instruction tried to expose hidden instructions.' },
  },
  {
    pattern: /\b(?:exfiltrate|steal|leak|send)\s+(?:all\s+)?(?:secrets|credentials|tokens|api keys|environment variables)\b/i,
    issue: { type: 'prompt_injection', severity: 'high', message: 'Prompt-injection instruction tried to exfiltrate secrets.' },
  },
  {
    pattern: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sh|bash)\b/i,
    issue: { type: 'malware_indicator', severity: 'high', message: 'Shell pipeline download-and-execute pattern was blocked.' },
  },
  {
    pattern: /\bpowershell\b[^\n]{0,200}\s-(?:enc|encodedcommand)\b/i,
    issue: { type: 'malware_indicator', severity: 'high', message: 'Encoded PowerShell execution pattern was blocked.' },
  },
  {
    pattern: /\bbase64\b[^\n|]{0,120}\|\s*(?:sh|bash|powershell)\b/i,
    issue: { type: 'malware_indicator', severity: 'high', message: 'Decoded payload execution pattern was blocked.' },
  },
  {
    pattern: /\brm\s+-rf\s+\/(?:\s|$)/i,
    issue: { type: 'malware_indicator', severity: 'high', message: 'Destructive root filesystem command was blocked.' },
  },
];

const SUSPICIOUS_PATTERNS: TextPattern[] = [
  {
    pattern: /\bjailbreak\b/i,
    issue: { type: 'prompt_injection', severity: 'medium', message: 'Jailbreak-related language was detected.' },
  },
  {
    pattern: /\b(?:bypass|disable)\s+(?:safety|guardrails|security)\b/i,
    issue: { type: 'prompt_injection', severity: 'medium', message: 'Safety-bypass language was detected.' },
  },
];

const PII_EMAIL_PATTERN: TextPattern = {
  pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  issue: { type: 'secret', severity: 'low', message: 'Email address was redacted (PII).', redacted: true },
};

const PII_PHONE_PATTERN: TextPattern = {
  pattern: /\b(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  issue: { type: 'secret', severity: 'low', message: 'Phone number was redacted (PII).', redacted: true },
};

const PII_IPV4_PATTERN: TextPattern = {
  pattern: /\b(?:25[0-5]|2[0-4]\d|[01]?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d?\d)){3}\b/g,
  issue: { type: 'secret', severity: 'low', message: 'IPv4 address was redacted (PII).', redacted: true },
};

export const REGEX_CLASSIFIER_NAME = 'regex';

export class RegexSuspiciousContentClassifier implements SuspiciousContentClassifier {
  readonly name = REGEX_CLASSIFIER_NAME;

  classify(text: string): SuspiciousContentClassification {
    const issues: KnowledgeSafetyIssue[] = [];
    for (const { pattern, issue } of BLOCK_PATTERNS) {
      if (pattern.test(text)) {
        issues.push(issue);
      }
    }
    for (const { pattern, issue } of SUSPICIOUS_PATTERNS) {
      if (pattern.test(text)) {
        issues.push(issue);
      }
    }
    return { issues };
  }
}

export class KnowledgeSafetyError extends SafetyBlockedError {
  constructor(readonly issues: KnowledgeSafetyIssue[]) {
    super(`Knowledge blocked by safety policy: ${issues.map((issue) => issue.message).join(' ')}`, issues);
  }
}

export class KnowledgeSafetyService {
  private readonly classifier: SuspiciousContentClassifier;
  private readonly policyAccessor: () => RetrievalPolicy;

  constructor(options: KnowledgeSafetyServiceOptions = {}) {
    this.classifier = options.classifier ?? new RegexSuspiciousContentClassifier();
    this.policyAccessor = options.policyAccessor ?? getRetrievalPolicy;
  }

  redactSecrets(value: string): string {
    return redactSecretPatterns(value, this.activePiiPatterns()).text;
  }

  /**
   * Phase 9 — exposes per-pattern firing counts for the safety evaluator. The
   * PII patterns are intentionally excluded here: this method measures the
   * static `SECRET_PATTERNS` list (the surface the FP/FN fixture targets).
   */
  scanForSecrets(value: string): SecretScanResult {
    const result = redactSecretPatterns(value);
    const perPattern: Record<string, number> = {};
    for (const name of result.firedPatterns) {
      perPattern[name] = (perPattern[name] ?? 0) + 1;
    }
    return {
      redactedText: result.text,
      redactionCount: result.redactionCount,
      firedPatterns: Array.from(new Set(result.firedPatterns)),
      perPattern,
    };
  }

  sanitizeKnowledgeInput(input: KnowledgeInput): KnowledgeInput {
    const title = this.scanAndRedactText(input.title);
    const summary = this.scanAndRedactText(input.summary ?? '');
    const content = this.scanAndRedactText(input.content);
    const decision = decideSafety([title, summary, content]);

    if (decision.status === 'blocked') {
      throw new KnowledgeSafetyError(decision.issues);
    }

    return {
      ...input,
      title: title.text,
      summary: summary.text,
      content: content.text,
      metadata: {
        ...(input.metadata ?? {}),
        safety: buildSafetyMetadata(decision),
      },
    };
  }

  sanitizeReflectionDraft(input: ReflectionDraftInput): ReflectionDraftInput {
    const title = this.scanAndRedactText(input.title);
    const summary = this.scanAndRedactText(input.summary);
    const content = this.scanAndRedactText(input.content);
    const decision = decideSafety([title, summary, content]);

    if (decision.status === 'blocked') {
      throw new KnowledgeSafetyError(decision.issues);
    }

    return {
      ...input,
      title: title.text,
      summary: summary.text,
      content: content.text,
      metadata: {
        ...(input.metadata ?? {}),
        safety: buildSafetyMetadata(decision),
      },
    };
  }

  sanitizeSearchCandidates<T extends SearchCandidate | RankedCandidate>(
    candidates: T[],
    options: SafetySanitizeOptions = {},
  ): T[] {
    return candidates
      .map((candidate) => this.sanitizeSearchCandidate(candidate, options))
      .filter((candidate): candidate is T => Boolean(candidate));
  }

  sanitizeContextPack<T extends { sections: Array<{ items: RankedCandidate[]; tokenEstimate: number }> }>(
    pack: T,
    options: SafetySanitizeOptions = {},
  ): T {
    return {
      ...pack,
      sections: pack.sections.map((section) => {
        const items = this.sanitizeSearchCandidates(section.items, options);
        return {
          ...section,
          items,
          tokenEstimate: items.reduce((sum, item) => sum + item.tokenEstimate, 0),
        };
      }),
    };
  }

  private sanitizeSearchCandidate<T extends SearchCandidate | RankedCandidate>(
    candidate: T,
    options: SafetySanitizeOptions = {},
  ): T | undefined {
    if (isMetadataBlocked(candidate.metadata)) {
      options.onFilterEvent?.({
        filter: 'safety_block_retrieval',
        action: 'excluded',
        knowledgeId: candidate.knowledgeId,
        reason: 'Knowledge was previously marked unsafe at ingestion (metadata.safety.status=blocked).',
      });
      return undefined;
    }

    const title = this.scanAndRedactText(candidate.title);
    const summary = this.scanAndRedactText(candidate.summary);
    const content = this.scanAndRedactText(candidate.content);
    const contextualContent = this.scanAndRedactText(candidate.contextualContent);
    const decision = decideSafety([title, summary, content, contextualContent]);

    if (decision.status === 'blocked') {
      options.onFilterEvent?.({
        filter: 'safety_block_retrieval',
        action: 'excluded',
        knowledgeId: candidate.knowledgeId,
        reason: `Retrieval-time scan blocked candidate: ${decision.issues.map((issue) => issue.message).join('; ')}`,
        metadata: { issues: decision.issues },
      });
      return undefined;
    }

    if (decision.redactionCount > 0 || decision.status === 'suspicious') {
      options.onFilterEvent?.({
        filter: 'safety_redact_retrieval',
        action: 'redacted',
        knowledgeId: candidate.knowledgeId,
        reason: `Retrieval-time scan redacted ${decision.redactionCount} secret(s); status=${decision.status}.`,
        metadata: { redactionCount: decision.redactionCount, status: decision.status },
      });
    }

    return {
      ...candidate,
      title: title.text,
      summary: summary.text,
      content: content.text,
      contextualContent: contextualContent.text,
      metadata: {
        ...(candidate.metadata ?? {}),
        retrievalSafety: buildSafetyMetadata(decision),
      },
    };
  }

  private scanAndRedactText(value: string): TextScanResult {
    const redacted = redactSecretPatterns(value, this.activePiiPatterns());
    const text = redacted.text;
    const classification = this.classifier.classify(text);
    const issues: KnowledgeSafetyIssue[] = uniqueIssues([...redacted.issues, ...classification.issues]);
    return { text, issues, redactionCount: redacted.redactionCount, firedPatterns: redacted.firedPatterns };
  }

  private activePiiPatterns(): TextPattern[] {
    const policy = safePolicy(this.policyAccessor);
    if (!policy?.piiRedaction) return [];
    const patterns: TextPattern[] = [];
    if (policy.piiRedaction.emails) patterns.push(PII_EMAIL_PATTERN);
    if (policy.piiRedaction.phones) patterns.push(PII_PHONE_PATTERN);
    if (policy.piiRedaction.ipv4) patterns.push(PII_IPV4_PATTERN);
    return patterns;
  }
}

function safePolicy(accessor: () => RetrievalPolicy): RetrievalPolicy | undefined {
  try {
    return accessor();
  } catch {
    return undefined;
  }
}

function redactSecretPatterns(value: string, extraPatterns: TextPattern[] = []): TextScanResult {
  let text = value;
  const issues: KnowledgeSafetyIssue[] = [];
  const firedPatterns: string[] = [];
  let redactionCount = 0;
  const patterns = extraPatterns.length === 0 ? SECRET_PATTERNS : [...SECRET_PATTERNS, ...extraPatterns];

  for (const entry of patterns) {
    const { pattern, issue, validator, name } = entry;
    const beforeText = text;
    text = text.replace(pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      // The replace callback signature is
      //   (match, ...captures, offset, string[, groups])
      // — with named-capture groups the trailing `groups` object is appended
      // after `string`, so we have to peel from the right.
      const lastArg = args[args.length - 1];
      const hasGroups = lastArg !== null && typeof lastArg === 'object';
      const groups = hasGroups ? (lastArg as Record<string, string | undefined>) : undefined;
      const offsetIndex = hasGroups ? args.length - 3 : args.length - 2;
      const rawOffset = args[offsetIndex];
      const offset = typeof rawOffset === 'number' ? rawOffset : 0;
      const valueGroup = groups?.value ?? match;
      if (validator) {
        const keep = validator({ fullMatch: match, value: valueGroup, matchIndex: offset, fullText: beforeText });
        if (!keep) {
          return match;
        }
      }
      issues.push(issue);
      redactionCount += 1;
      if (name) {
        firedPatterns.push(name);
      }
      return `[REDACTED:${issue.type}]`;
    });
  }

  return { text, issues: uniqueIssues(issues), redactionCount, firedPatterns };
}

function decideSafety(scans: TextScanResult[]): SafetyDecision {
  const issues = uniqueIssues(scans.flatMap((scan) => scan.issues));
  const redactionCount = scans.reduce((sum, scan) => sum + scan.redactionCount, 0);
  const blocked = issues.some((issue) => issue.severity === 'high' && issue.type !== 'secret' && !issue.redacted);
  const suspicious = issues.some((issue) => issue.severity === 'medium' && issue.type !== 'secret');

  return {
    status: blocked ? 'blocked' : suspicious ? 'suspicious' : 'safe',
    injectable: !blocked,
    issues,
    redactionCount,
  };
}

function buildSafetyMetadata(decision: SafetyDecision): KnowledgeSafetyMetadata {
  return {
    status: decision.status,
    injectable: decision.injectable,
    issues: decision.issues,
    redactionCount: decision.redactionCount,
    checkedAt: new Date().toISOString(),
  };
}

function isMetadataBlocked(metadata: Record<string, unknown> | undefined): boolean {
  const safety = metadata?.safety;
  if (!safety || typeof safety !== 'object') {
    return false;
  }

  const record = safety as Record<string, unknown>;
  return record.status === 'blocked' || record.injectable === false;
}

function uniqueIssues(issues: KnowledgeSafetyIssue[]): KnowledgeSafetyIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.type}:${issue.severity}:${issue.message}:${issue.redacted ?? false}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
