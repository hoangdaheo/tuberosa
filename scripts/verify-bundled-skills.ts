import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLED_SKILLS_MANIFEST,
  parseManifest,
  manifestSkillFilePaths,
  manifestSkillDirs,
  findFilesDrift,
} from '../bin/commands/bundled-skills.js';

/**
 * prepack gate: the bundled-skills manifest is the single source of truth. Fail the
 * pack/publish if the manifest, the on-disk skill files, and package.json "files"
 * disagree — so the package can never ship a skill init's default skills install
 * won't copy, or promise a skill it doesn't ship.
 */
async function main(): Promise<void> {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestRel = `.claude/skills/${BUNDLED_SKILLS_MANIFEST}`;
  const errors: string[] = [];

  const manifest = parseManifest(await readFile(resolve(repoRoot, manifestRel), 'utf8'));
  const pkg = JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf8')) as { files?: string[] };
  const files = pkg.files ?? [];

  // 1. The manifest file itself must ship, or the consumer's `init` can't read it.
  if (!files.includes(manifestRel)) {
    errors.push(`package.json "files" must include "${manifestRel}"`);
  }

  // 2. package.json "files" skill dirs must match the manifest exactly.
  const { missingFromFiles, extraInFiles } = findFilesDrift(manifestSkillDirs(manifest), files);
  for (const dir of missingFromFiles) {
    errors.push(`manifest lists "${dir}" but package.json "files" does not ship it`);
  }
  for (const entry of extraInFiles) {
    errors.push(`package.json "files" ships "${entry}" but the manifest does not list it`);
  }

  // 3. Every file the manifest references must exist on disk.
  for (const rel of manifestSkillFilePaths(manifest)) {
    if (!existsSync(resolve(repoRoot, '.claude/skills', rel))) {
      errors.push(`manifest references a missing file: .claude/skills/${rel}`);
    }
  }

  // 4. Consumer-safety: shipped SKILL.md files must not reference repo-internal
  //    paths or contributor commands that don't exist in a consumer project.
  //    The lookbehind `(?<![a-zA-Z])eval\/` (not a bare `eval/`) keeps the match
  //    index on `eval/` itself, so reported line numbers stay correct, while still
  //    making sure `retrieval/ingest` doesn't false-positive.
  const FORBIDDEN: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /docs\//, label: 'repo-internal docs/ path' },
    { pattern: /pnpm run/, label: 'contributor-only pnpm script' },
    { pattern: /(?<![a-zA-Z])eval\//, label: 'repo-internal eval/ path' },
  ];
  for (const rel of manifestSkillFilePaths(manifest)) {
    if (!rel.endsWith('SKILL.md')) continue;
    const fullPath = resolve(repoRoot, '.claude/skills', rel);
    if (!existsSync(fullPath)) continue; // already reported by check 3
    const contents = await readFile(fullPath, 'utf8');
    for (const { pattern, label } of FORBIDDEN) {
      // First occurrence per pattern is deliberate: one hit fails the gate; rerun after fixing.
      const match = pattern.exec(contents);
      if (match) {
        const line = contents.slice(0, match.index).split('\n').length;
        errors.push(`.claude/skills/${rel}:${line} contains a ${label} — shipped skills must be consumer-safe`);
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write(
      'Bundled-skills verification FAILED:\n' + errors.map((e) => `  - ${e}`).join('\n') + '\n',
    );
    process.exit(1);
  }
  process.stdout.write(
    `Bundled-skills OK: ${manifest.skills.length} skill(s), ${manifestSkillFilePaths(manifest).length} file(s) shipped.\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`verify-bundled-skills: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
