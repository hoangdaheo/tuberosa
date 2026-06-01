/**
 * Deterministic bootstrap extraction-inputs assembler.
 *
 * Converts an `AtlasInputs` snapshot (and optional raw doc strings) into a
 * structured `ExtractionInputs` bag that a calling agent can distill into
 * project conventions. This module is PURE — no model calls, no I/O, no
 * `Date.now`, no `Math.random` — so the same inputs always produce identical
 * outputs. That property is required for the bootstrap pipeline's eval gate.
 *
 * Tech detection is intentionally keyword-based and conservative: only signal
 * what is actually evidenced by script commands or area paths.
 *
 * Ordering contracts (must stay stable across runs):
 *   - `areas`:          input order (inherited from `AtlasInputs.areas`)
 *   - `detectedTech`:   alphabetical, deduped
 *   - `docExcerpts`:    readme → readmeCommands → contributing (present only)
 *   - `recurringHints`: area hints first (area input order), then script hints
 *                       (alphabetical script-name order)
 */

import type { AtlasInputs } from '../atlas/inputs.js';

// Re-export the input type so callers only need one import.
export type { AtlasInputs };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtractionInputs {
  /** Tech keywords detected from script commands / area extensions (sorted, deduped). */
  detectedTech: string[];
  /** Areas derived from AtlasInputs.areas, in input order. */
  areas: { key: string; label: string; fileCount: number }[];
  /** Verbatim copy of AtlasInputs.scripts. */
  scripts: Record<string, string>;
  /** Truncated excerpts from available documentation. */
  docExcerpts: { source: string; excerpt: string }[];
  /** Human-readable convention signals for the distillation agent. */
  recurringHints: string[];
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Max character (code-point) length before an excerpt is truncated. */
export const MAX_EXCERPT_LENGTH = 1200;

/** Script name substring patterns that mark recurring workflow gates. */
const GATE_PATTERNS = ['test', 'lint', 'build', 'eval'];

/**
 * Minimum file count for an area to warrant a "module boundaries" hint.
 * One-file areas have nothing to organise.
 */
const AREA_HINT_MIN_FILES = 2;

// ---------------------------------------------------------------------------
// Tech detection
// ---------------------------------------------------------------------------

/**
 * Detect technology keywords from script commands and (optionally) area paths.
 *
 * Each rule checks a simple substring/regex against the concatenated script
 * names+commands. Only emits a keyword when evidence is present — does not
 * invent tech from thin air.
 */
function detectTech(scripts: Record<string, string>, areas: AtlasInputs['areas']): string[] {
  const scriptText = Object.entries(scripts)
    .flatMap(([name, cmd]) => [name, cmd])
    .join(' ');

  const pathText = areas.flatMap((a) => a.paths).join(' ');

  const combined = `${scriptText} ${pathText}`;

  const detected = new Set<string>();

  if (/\btsc\b/.test(scriptText) || /\.tsx?\b/.test(combined)) detected.add('typescript');
  if (/\breact\b/i.test(scriptText) || /\.tsx\b/.test(combined)) detected.add('react');
  if (/\bpnpm\b/.test(scriptText)) detected.add('pnpm');
  if (/\bmigrate\b/.test(scriptText) || /\.sql\b/.test(combined)) detected.add('postgres');

  return [...detected].sort();
}

// ---------------------------------------------------------------------------
// Doc excerpt helpers
// ---------------------------------------------------------------------------

/**
 * Truncate text to `MAX_EXCERPT_LENGTH` code points, appending `'…'` if cut.
 *
 * Uses code-point iteration (`[...text]`) rather than `String.slice`, which is
 * UTF-16-code-unit based and could split a surrogate pair mid-character for
 * non-BMP content (emoji, some CJK extensions) in README/CONTRIBUTING text.
 */
function truncateExcerpt(text: string): string {
  const codePoints = [...text];
  if (codePoints.length <= MAX_EXCERPT_LENGTH) return text;
  return `${codePoints.slice(0, MAX_EXCERPT_LENGTH).join('')}…`;
}

// ---------------------------------------------------------------------------
// Recurring hints
// ---------------------------------------------------------------------------

/** Determine whether a script name looks like a CI / workflow gate. */
function isGateScript(name: string): boolean {
  const lower = name.toLowerCase();
  return GATE_PATTERNS.some((pattern) => lower.includes(pattern));
}

function buildAreaHints(areas: AtlasInputs['areas']): string[] {
  return areas
    .filter((a) => a.counts.files >= AREA_HINT_MIN_FILES)
    .map(
      (a) =>
        `Area '${a.key}' spans ${a.counts.files} files — consider a convention for its module boundaries.`,
    );
}

function buildScriptHints(scripts: Record<string, string>): string[] {
  return Object.entries(scripts)
    .filter(([name]) => isGateScript(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, cmd]) => `Script '${name}' (\`${cmd}\`) is a recurring workflow gate.`);
}

// ---------------------------------------------------------------------------
// Public assembler
// ---------------------------------------------------------------------------

/**
 * Assemble deterministic extraction inputs from an atlas snapshot and optional
 * raw doc strings.
 *
 * @param atlasInputs - Full atlas snapshot for the project.
 * @param docs        - Optional raw doc strings (readme, contributing). Pass
 *                      non-empty strings only; empty strings are silently
 *                      omitted from `docExcerpts`.
 */
export function assembleExtractionInputs(
  atlasInputs: AtlasInputs,
  docs?: { readme?: string; contributing?: string },
): ExtractionInputs {
  // --- scripts (verbatim) --------------------------------------------------
  const scripts = atlasInputs.scripts;

  // --- areas ---------------------------------------------------------------
  const areas = atlasInputs.areas.map((a) => ({
    key: a.key,
    label: a.label,
    fileCount: a.counts.files,
  }));

  // --- detectedTech --------------------------------------------------------
  const detectedTech = detectTech(atlasInputs.scripts, atlasInputs.areas);

  // --- docExcerpts (order: readme → readmeCommands → contributing) ---------
  const docExcerpts: { source: string; excerpt: string }[] = [];

  if (docs?.readme) {
    docExcerpts.push({ source: 'README.md', excerpt: truncateExcerpt(docs.readme) });
  }

  if (atlasInputs.readmeCommands) {
    docExcerpts.push({
      source: 'README.md#Commands',
      excerpt: truncateExcerpt(atlasInputs.readmeCommands),
    });
  }

  if (docs?.contributing) {
    docExcerpts.push({ source: 'CONTRIBUTING.md', excerpt: truncateExcerpt(docs.contributing) });
  }

  // --- recurringHints (area hints first, then script hints) ----------------
  const recurringHints = [
    ...buildAreaHints(atlasInputs.areas),
    ...buildScriptHints(atlasInputs.scripts),
  ];

  return { detectedTech, areas, scripts, docExcerpts, recurringHints };
}
