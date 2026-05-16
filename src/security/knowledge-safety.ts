import type { KnowledgeInput, RankedCandidate, ReflectionDraftInput, SearchCandidate } from '../types.js';

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
}

interface SafetyDecision {
  status: KnowledgeSafetyStatus;
  injectable: boolean;
  issues: KnowledgeSafetyIssue[];
  redactionCount: number;
}

interface TextPattern {
  pattern: RegExp;
  issue: KnowledgeSafetyIssue;
}

const SECRET_PATTERNS: TextPattern[] = [
  {
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    issue: { type: 'secret', severity: 'high', message: 'Private key material was redacted.', redacted: true },
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'OpenAI-style API key was redacted.', redacted: true },
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'GitHub token was redacted.', redacted: true },
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    issue: { type: 'secret', severity: 'high', message: 'AWS access key id was redacted.', redacted: true },
  },
  {
    pattern: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^"'\s]{12,}["']?/gi,
    issue: { type: 'secret', severity: 'medium', message: 'Credential-like assignment was redacted.', redacted: true },
  },
];

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

export class KnowledgeSafetyError extends Error {
  readonly statusCode = 400;

  constructor(readonly issues: KnowledgeSafetyIssue[]) {
    super(`Knowledge blocked by safety policy: ${issues.map((issue) => issue.message).join(' ')}`);
  }
}

export class KnowledgeSafetyService {
  redactSecrets(value: string): string {
    return redactSecretPatterns(value).text;
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

  sanitizeSearchCandidates<T extends SearchCandidate | RankedCandidate>(candidates: T[]): T[] {
    return candidates
      .map((candidate) => this.sanitizeSearchCandidate(candidate))
      .filter((candidate): candidate is T => Boolean(candidate));
  }

  sanitizeContextPack<T extends { sections: Array<{ items: RankedCandidate[]; tokenEstimate: number }> }>(pack: T): T {
    return {
      ...pack,
      sections: pack.sections.map((section) => {
        const items = this.sanitizeSearchCandidates(section.items);
        return {
          ...section,
          items,
          tokenEstimate: items.reduce((sum, item) => sum + item.tokenEstimate, 0),
        };
      }),
    };
  }

  private sanitizeSearchCandidate<T extends SearchCandidate | RankedCandidate>(candidate: T): T | undefined {
    if (isMetadataBlocked(candidate.metadata)) {
      return undefined;
    }

    const title = this.scanAndRedactText(candidate.title);
    const summary = this.scanAndRedactText(candidate.summary);
    const content = this.scanAndRedactText(candidate.content);
    const contextualContent = this.scanAndRedactText(candidate.contextualContent);
    const decision = decideSafety([title, summary, content, contextualContent]);

    if (decision.status === 'blocked') {
      return undefined;
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
    const redacted = redactSecretPatterns(value);
    let text = redacted.text;
    const issues: KnowledgeSafetyIssue[] = [...redacted.issues];
    const redactionCount = redacted.redactionCount;

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

    return { text, issues: uniqueIssues(issues), redactionCount };
  }
}

function redactSecretPatterns(value: string): TextScanResult {
  let text = value;
  const issues: KnowledgeSafetyIssue[] = [];
  let redactionCount = 0;

  for (const { pattern, issue } of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      issues.push(issue);
      redactionCount += 1;
      return `[REDACTED:${issue.type}]`;
    });
  }

  return { text, issues: uniqueIssues(issues), redactionCount };
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
