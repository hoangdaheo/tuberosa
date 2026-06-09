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
 * disagree — so the package can never ship a skill `init --with-skills` won't copy,
 * or promise a skill it doesn't ship.
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
