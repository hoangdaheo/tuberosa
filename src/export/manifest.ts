import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { BundleManifest } from '../types/export-bundle.js';

export const SCHEMA_VERSION = 2;

export async function sha256OfFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

export function sha256OfBuffer(buf: Buffer | string): string {
  return 'sha256:' + createHash('sha256').update(buf).digest('hex');
}

/**
 * Writes a manifest with a `manifest_self` integrity entry. The hash is
 * computed over the bytes of the manifest itself with `manifest_self` set to
 * the literal "pending", so a reader can recompute it without knowing the
 * final hash.
 */
export async function writeManifest(path: string, manifest: BundleManifest): Promise<void> {
  const base: BundleManifest = {
    ...manifest,
    integrity: { ...manifest.integrity, manifest_self: 'pending' },
  };
  const baseBytes = Buffer.from(JSON.stringify(base, null, 2), 'utf8');
  const selfHash = sha256OfBuffer(baseBytes);
  const final: BundleManifest = {
    ...manifest,
    integrity: { ...manifest.integrity, manifest_self: selfHash },
  };
  await writeFile(path, JSON.stringify(final, null, 2), 'utf8');
}

export async function readManifest(path: string): Promise<BundleManifest> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as BundleManifest;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `Unsupported pack schemaVersion ${parsed.schemaVersion} (this Tuberosa supports ${SCHEMA_VERSION})`,
    );
  }
  return parsed;
}
