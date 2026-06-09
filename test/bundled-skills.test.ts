import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseManifest,
  manifestSkillFilePaths,
  manifestSkillDirs,
  findFilesDrift,
} from '../bin/commands/bundled-skills.js';

describe('bundled-skills manifest', () => {
  it('parses a valid manifest', () => {
    const m = parseManifest('{"skills":[{"name":"a","files":["SKILL.md"]}]}');
    assert.deepEqual(m, { skills: [{ name: 'a', files: ['SKILL.md'] }] });
  });

  it('throws when skills is not an array', () => {
    assert.throws(() => parseManifest('{"skills":{}}'), /skills/);
  });

  it('throws when a skill name is empty', () => {
    assert.throws(() => parseManifest('{"skills":[{"name":"","files":["SKILL.md"]}]}'), /name/);
  });

  it('throws when files is not a string array', () => {
    assert.throws(() => parseManifest('{"skills":[{"name":"a","files":[1]}]}'), /files/);
  });

  it('flattens skill file paths', () => {
    const m = {
      skills: [
        { name: 'a', files: ['SKILL.md'] },
        { name: 'b', files: ['SKILL.md', 'references/x.md'] },
      ],
    };
    assert.deepEqual(manifestSkillFilePaths(m), ['a/SKILL.md', 'b/SKILL.md', 'b/references/x.md']);
  });

  it('lists skill dirs with a trailing slash (matching package.json files entries)', () => {
    const m = { skills: [{ name: 'a', files: ['SKILL.md'] }] };
    assert.deepEqual(manifestSkillDirs(m), ['.claude/skills/a/']);
  });

  it('reports no drift when files match the manifest (manifest json entry ignored)', () => {
    const report = findFilesDrift(
      ['.claude/skills/a/'],
      ['dist/', '.claude/skills/bundled-skills.json', '.claude/skills/a/'],
    );
    assert.deepEqual(report, { missingFromFiles: [], extraInFiles: [] });
  });

  it('detects a manifest skill missing from files', () => {
    const report = findFilesDrift(['.claude/skills/a/', '.claude/skills/b/'], ['.claude/skills/a/']);
    assert.deepEqual(report.missingFromFiles, ['.claude/skills/b/']);
    assert.deepEqual(report.extraInFiles, []);
  });

  it('detects a shipped skill the manifest does not list', () => {
    const report = findFilesDrift(['.claude/skills/a/'], ['.claude/skills/a/', '.claude/skills/b/']);
    assert.deepEqual(report.missingFromFiles, []);
    assert.deepEqual(report.extraInFiles, ['.claude/skills/b/']);
  });
});
