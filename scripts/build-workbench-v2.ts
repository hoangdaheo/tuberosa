import esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src/workbench-v2');
const outDir = join(root, 'dist/workbench');

const watch = process.argv.includes('--watch');

async function run(): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const options: esbuild.BuildOptions = {
    entryPoints: [join(srcDir, 'app.tsx')],
    outdir: outDir,
    bundle: true,
    format: 'esm',
    target: ['es2020'],
    platform: 'browser',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    splitting: true,
    minify: !watch,
    sourcemap: true,
    metafile: true,
    loader: { '.css': 'css', '.json': 'json' },
    logLevel: 'info',
  };

  await copyFile(join(srcDir, 'index.html'), join(outDir, 'index.html'));

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[workbench-v2] watching...');
    return;
  }

  const result = await esbuild.build(options);
  console.log('[workbench-v2] bundle written to dist/workbench/');
  if (result.metafile) {
    const total = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
    console.log(`[workbench-v2] total output: ${(total / 1024).toFixed(1)} KB`);
  }
}

run().catch((err) => {
  console.error('[workbench-v2] build failed:', err);
  process.exit(1);
});
