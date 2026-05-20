import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const bundleRoot = locateBundleRoot(moduleDir);

function locateBundleRoot(start: string): string {
  let current = start;
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(current, 'package.json'))) {
      return join(current, 'dist/workbench');
    }
    const parent = resolve(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return join(start, 'dist/workbench');
}

const MIME: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function workbenchHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tuberosa Workbench</title>
  <link rel="stylesheet" href="/workbench/static/app.css">
</head>
<body>
  <div id="app"></div>
  <noscript>The Tuberosa Workbench needs JavaScript. Enable it or use the HTTP API directly.</noscript>
  <script type="module" src="/workbench/static/app.js"></script>
</body>
</html>
`;
}

export interface StaticAssetResult {
  contentType: string;
  body: Buffer;
}

export async function readWorkbenchAsset(relativePath: string): Promise<StaticAssetResult | undefined> {
  const safePath = normalize(relativePath).replace(/^\/+/, '');
  if (safePath.includes('..')) return undefined;
  const fullPath = join(bundleRoot, safePath);
  if (!fullPath.startsWith(bundleRoot)) return undefined;
  try {
    const fileStat = await stat(fullPath);
    if (!fileStat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const body = await readFile(fullPath);
  const contentType = MIME[extname(fullPath).toLowerCase()] ?? 'application/octet-stream';
  return { contentType, body };
}
