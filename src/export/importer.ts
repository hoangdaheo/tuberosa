import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { KnowledgeStore } from '../storage/store.js';
import type { KnowledgeAtom } from '../types/atoms.js';
import type { LabelInput, ReferenceInput } from '../types.js';
import { parseAtomMarkdown, toAtomInputFromParsed } from './atom-codec.js';
import { parseKnowledgeMarkdown } from './knowledge-codec.js';
import { parseEdgesJsonl } from './edges-codec.js';
import { readManifest, sha256OfBuffer } from './manifest.js';

export interface ImportOptions {
  from: string;
  project?: string;
  dryRun?: boolean;
  onConflict?: 'review' | 'skip';
}

export interface ImportReport {
  atomsInserted: number;
  atomsUnchanged: number;
  conflictsQueued: number;
  knowledgeInserted: number;
  knowledgeUnchanged: number;
  edgesInserted: number;
  edgesUpdated: number;
  bundleSource: string;
}

export async function importPack(
  store: KnowledgeStore,
  opts: ImportOptions,
): Promise<ImportReport> {
  const manifest = await readManifest(join(opts.from, 'manifest.json'));
  const project = opts.project ?? manifest.project;
  const report: ImportReport = {
    atomsInserted: 0,
    atomsUnchanged: 0,
    conflictsQueued: 0,
    knowledgeInserted: 0,
    knowledgeUnchanged: 0,
    edgesInserted: 0,
    edgesUpdated: 0,
    bundleSource: opts.from,
  };
  const onConflict = opts.onConflict ?? 'review';

  const edgesContent = await readFile(join(opts.from, 'edges.jsonl'), 'utf8');
  const expectedHash = manifest.integrity['edges.jsonl'];
  const actualHash = sha256OfBuffer(edgesContent);
  if (expectedHash && expectedHash !== actualHash) {
    process.stderr.write(
      `[import-pack] edges.jsonl hash mismatch: expected ${expectedHash}, got ${actualHash}\n`,
    );
  }

  const atomFiles = (await readdir(join(opts.from, 'atoms'))).filter((f) => f.endsWith('.md'));
  for (const file of atomFiles) {
    const raw = await readFile(join(opts.from, 'atoms', file), 'utf8');
    const parsed = parseAtomMarkdown(raw, { filename: `atoms/${file}` });
    const incoming = toAtomInputFromParsed(parsed);
    incoming.project = project;

    const existing = await store.getAtom(incoming.id);
    if (!existing) {
      if (!opts.dryRun) {
        const created = await store.createAtom({
          project: incoming.project,
          claim: incoming.claim,
          type: incoming.type,
          evidence: incoming.evidence,
          trigger: incoming.trigger,
          verification: incoming.verification,
          pitfalls: incoming.pitfalls,
          links: incoming.links,
          producedBy: 'user',
        });
        // Imported atoms always start at draft locally; the source's tier is
        // advisory and gets reviewed before promotion.
        await store.updateAtom(created.id, { tier: 'draft' });
      }
      report.atomsInserted += 1;
      continue;
    }

    if (atomsEquivalent(existing, incoming)) {
      report.atomsUnchanged += 1;
      continue;
    }

    if (onConflict === 'skip') {
      continue;
    }

    if (!opts.dryRun) {
      await store.createAtomImportConflict({
        project,
        atomId: existing.id,
        localSnapshot: existing,
        importedSnapshot: { ...parsed.frontmatter, body: parsed.body },
        bundleSource: opts.from,
      });
    }
    report.conflictsQueued += 1;
  }

  const kFiles = (await readdir(join(opts.from, 'knowledge'))).filter((f) => f.endsWith('.md'));
  for (const file of kFiles) {
    const raw = await readFile(join(opts.from, 'knowledge', file), 'utf8');
    const parsed = parseKnowledgeMarkdown(raw, { filename: `knowledge/${file}` });
    const existing = await store.getKnowledge(parsed.frontmatter.id);
    if (!existing) {
      if (!opts.dryRun) {
        await store.upsertKnowledge(
          {
            project,
            sourceType: 'imported',
            sourceUri: `bundle://${opts.from}/${file}`,
            itemType: parsed.frontmatter.itemType,
            title: parsed.frontmatter.title,
            summary: '',
            content: parsed.body.trim(),
            labels: parsed.frontmatter.labels as LabelInput[],
            references: parsed.frontmatter.references as ReferenceInput[],
            trustLevel: parsed.frontmatter.trustLevel,
            metadata: { importedFrom: opts.from },
          },
          [],
        );
      }
      report.knowledgeInserted += 1;
    } else {
      report.knowledgeUnchanged += 1;
    }
  }

  const edges = parseEdgesJsonl(edgesContent);
  for (const edge of edges) {
    const existing = await store.listAtomRelations({
      fromAtomId: edge.from,
      targetAtomId: edge.to,
      limit: 5,
    });
    const same = existing.find(
      (r) => r.relationType === edge.kind && r.inferenceSource === edge.inferenceSource,
    );
    if (!same) {
      if (!opts.dryRun) {
        await store.replaceAtomRelations(
          edge.from,
          [
            {
              fromAtomId: edge.from,
              targetAtomId: edge.to,
              relationType: edge.kind,
              confidence: edge.confidence,
              inferenceSource: edge.inferenceSource,
            },
          ],
          { source: edge.inferenceSource },
        );
      }
      report.edgesInserted += 1;
    } else if (edge.confidence > same.confidence) {
      if (!opts.dryRun) {
        await store.replaceAtomRelations(
          edge.from,
          [
            {
              fromAtomId: edge.from,
              targetAtomId: edge.to,
              relationType: edge.kind,
              confidence: edge.confidence,
              inferenceSource: edge.inferenceSource,
            },
          ],
          { source: edge.inferenceSource },
        );
      }
      report.edgesUpdated += 1;
    }
  }

  return report;
}

function atomsEquivalent(a: KnowledgeAtom, b: KnowledgeAtom): boolean {
  return (
    a.claim === b.claim
    && a.type === b.type
    && JSON.stringify(a.evidence) === JSON.stringify(b.evidence)
    && JSON.stringify(a.trigger) === JSON.stringify(b.trigger)
  );
}
