import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore, AtlasRunRecord } from '../storage/store.js';
import { gatherAtlasInputs, type AtlasInputs } from './inputs.js';
import { buildProjectMap, buildFlows, buildCommands, buildRisks, buildOpenGaps } from './builders.js';
import { sha256OfBuffer } from '../export/manifest.js';

export interface AtlasRegenArgs {
  project: string;
  repoPath: string;
  generatedAt: string;
  write?: boolean;
}

export interface AtlasRegenResult {
  inputHash: string;
  files: { name: string; bytes: number }[];
  contents: { name: string; content: string }[];
  atlasRun?: AtlasRunRecord;
}

const BUILDERS: { name: string; build: (i: AtlasInputs) => string }[] = [
  { name: 'project-map.md', build: buildProjectMap },
  { name: 'flows.md', build: buildFlows },
  { name: 'commands.md', build: buildCommands },
  { name: 'risks.md', build: buildRisks },
  { name: 'open-gaps.md', build: buildOpenGaps },
];

export class AtlasService {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly config: { atlasDir: string },
  ) {}

  async regenerate(args: AtlasRegenArgs): Promise<AtlasRegenResult> {
    const inputs = await gatherAtlasInputs(this.store, args);
    // Hash covers inputs only (NOT generatedAt/repoPath) so an unchanged project is stable.
    const hashable = JSON.stringify({ ...inputs, generatedAt: undefined, repoPath: undefined });
    const inputHash = sha256OfBuffer(hashable);
    const hash8 = inputHash.replace(/^sha256:/, '').slice(0, 8);

    const contents = BUILDERS.map(({ name, build }) => ({
      name,
      content: build(inputs).replace(/input PENDING/g, `input ${hash8}`),
    }));
    const files = contents.map((c) => ({ name: c.name, bytes: Buffer.byteLength(c.content, 'utf8') }));

    let atlasRun: AtlasRunRecord | undefined;
    if (args.write) {
      await mkdir(this.config.atlasDir, { recursive: true });
      for (const c of contents) {
        await writeFile(join(this.config.atlasDir, c.name), c.content, 'utf8');
      }
      atlasRun = await this.store.createAtlasRun({
        project: args.project,
        inputHash,
        files,
        generatedAt: args.generatedAt,
      });
    }
    return { inputHash, files, contents, atlasRun };
  }
}
