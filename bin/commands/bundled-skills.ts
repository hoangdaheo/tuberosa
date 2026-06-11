/**
 * Single source of truth for which agent skills Tuberosa bundles and ships.
 *
 * The manifest (`.claude/skills/bundled-skills.json`) is authoritative. Both the
 * runtime copier (init's default skills install) and the publish-time gate
 * (`scripts/verify-bundled-skills.ts`) derive their behaviour from it, so the
 * package's `files` allowlist can never silently drift from what `init` copies.
 *
 * This module is PURE (no I/O) so it is trivially unit-testable.
 */

export interface BundledSkill {
  /** Skill folder name under `.claude/skills/`, e.g. `tuberosa-onboard-project`. */
  name: string;
  /** Files within the skill folder to ship/copy, e.g. `['SKILL.md']`. */
  files: string[];
}

export interface BundledSkillManifest {
  skills: BundledSkill[];
}

/** The manifest file name, resolved relative to the skills root at runtime. */
export const BUNDLED_SKILLS_MANIFEST = 'bundled-skills.json';

/** Parse + validate the manifest JSON. Throws a descriptive Error on a bad shape. */
export function parseManifest(json: string): BundledSkillManifest {
  const data: unknown = JSON.parse(json);
  if (!data || typeof data !== 'object' || !Array.isArray((data as { skills?: unknown }).skills)) {
    throw new Error('bundled-skills manifest must be an object with a "skills" array');
  }
  const skills = (data as { skills: unknown[] }).skills.map((entry, index) => {
    const skill = entry as { name?: unknown; files?: unknown };
    if (typeof skill.name !== 'string' || skill.name.length === 0) {
      throw new Error(`bundled-skills manifest skills[${index}].name must be a non-empty string`);
    }
    if (!Array.isArray(skill.files) || skill.files.some((f) => typeof f !== 'string' || f.length === 0)) {
      throw new Error(`bundled-skills manifest skills[${index}].files must be an array of non-empty strings`);
    }
    return { name: skill.name, files: skill.files as string[] };
  });
  return { skills };
}

/** Flatten to `<name>/<file>` paths relative to the skills root. */
export function manifestSkillFilePaths(manifest: BundledSkillManifest): string[] {
  return manifest.skills.flatMap((skill) => skill.files.map((file) => `${skill.name}/${file}`));
}

/** The `package.json` "files" directory entries (trailing slash) the manifest implies. */
export function manifestSkillDirs(manifest: BundledSkillManifest): string[] {
  return manifest.skills.map((skill) => `.claude/skills/${skill.name}/`);
}

export interface DriftReport {
  /** Manifest skill dirs that `package.json` "files" does not ship. */
  missingFromFiles: string[];
  /** Skill dirs `package.json` "files" ships that the manifest does not list. */
  extraInFiles: string[];
}

/**
 * Compare the manifest's skill dirs against the `package.json` "files" entries.
 * The manifest JSON file's own entry (`.claude/skills/bundled-skills.json`) is
 * ignored here — the gate script checks for it separately.
 */
export function findFilesDrift(manifestDirs: string[], filesEntries: string[]): DriftReport {
  const shippedSkillDirs = filesEntries.filter(
    (entry) => entry.startsWith('.claude/skills/') && entry !== `.claude/skills/${BUNDLED_SKILLS_MANIFEST}`,
  );
  const expected = new Set(manifestDirs);
  const actual = new Set(shippedSkillDirs);
  return {
    missingFromFiles: manifestDirs.filter((dir) => !actual.has(dir)),
    extraInFiles: [...actual].filter((entry) => !expected.has(entry)),
  };
}
