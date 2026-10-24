import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bundlePath = fileURLToPath(new URL('../public/app.js', import.meta.url));
const entryPath = fileURLToPath(new URL('../web/main.tsx', import.meta.url));

export type UiBundleState = 'present' | 'built' | 'unavailable';

/**
 * `public/app.js` is a generated bundle and is not committed, so a fresh checkout — or a
 * container start before `npm run dev` — would otherwise serve an empty dashboard. Building it
 * once on boot keeps the dashboard usable from any entry point. esbuild is a dev dependency, so
 * a production image without node_modules simply reports that the bundle is missing.
 */
export async function ensureUiBundle(): Promise<UiBundleState> {
  if (existsSync(bundlePath)) return 'present';
  if (!existsSync(entryPath)) return 'unavailable';
  try {
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [entryPath],
      outfile: bundlePath,
      bundle: true,
      format: 'esm',
      target: 'es2022',
      jsx: 'automatic',
      minify: true,
      legalComments: 'none',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    return 'built';
  } catch {
    return 'unavailable';
  }
}
