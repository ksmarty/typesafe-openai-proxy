/**
 * Bundles the dashboard (React + Material UI) into public/app.js.
 *
 * The server stays a zero-dependency Node process: it only serves the files this writes.
 * `--watch` keeps it in step with the TypeScript server while developing.
 */

import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['web/main.tsx'],
  bundle: true,
  outfile: 'public/app.js',
  format: 'esm',
  target: ['es2022'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
  },
  logLevel: 'info',
};

if (watch) {
  const running = await context(options);
  await running.watch();
  console.log('watching web/ — rebuilds public/app.js on change');
} else {
  await build(options);
}
