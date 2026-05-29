import type { AtomFrontmatter } from '../types/export-bundle.js';
import type { KnowledgeAtomPatch } from '../types/atoms.js';

/**
 * Build a full content patch from an imported atom snapshot so `take_imported`
 * updates claim/type/evidence/trigger (not just tier/status). Mirrors
 * `toAtomInputFromParsed`: claim falls back to the markdown body.
 */
export function importedSnapshotToPatch(imp: AtomFrontmatter & { body: string }): KnowledgeAtomPatch {
  return {
    claim: imp.claim ?? imp.body.trim(),
    type: imp.type,
    evidence: imp.evidence,
    trigger: imp.trigger,
    verification: imp.verification,
    pitfalls: imp.pitfalls,
    links: imp.links,
    tier: imp.tier,
    status: imp.status,
  };
}
