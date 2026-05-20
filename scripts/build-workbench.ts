import esbuild from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src/workbench');
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
    minify: !watch,
    sourcemap: true,
    metafile: false,
    loader: { '.css': 'css' },
    logLevel: 'info',
  };

  await copyFile(join(srcDir, 'index.html'), join(outDir, 'index.html'));

  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[workbench] watching for changes...');
    return;
  }

  await esbuild.build(options);
  console.log('[workbench] bundle written to dist/workbench/');
}

run().catch((error) => {
  console.error('[workbench] build failed:', error);
  process.exit(1);
});
