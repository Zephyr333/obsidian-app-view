import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'cjs', target: 'es2018', outfile: 'main.js', external: ['obsidian', '@codemirror/state', '@codemirror/view'], sourcemap: false });
await mkdir('dist/app-view', { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) await copyFile(file, `dist/app-view/${file}`);
