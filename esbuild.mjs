import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const scriptsOnly = process.argv.includes('--scripts');
const prod = !watch && !scriptsOnly;

const builds = scriptsOnly
  ? ['sweep', 'preview', 'check-manifest', 'compare-dmx'].map((n) => ({
      entryPoints: [`scripts/${n}.ts`], outfile: `out/${n}.js`, bundle: true, platform: 'node', format: 'cjs', target: 'node20', sourcemap: true,
    }))
  : [
      // Extension host (Node). `vscode` is provided at runtime.
      { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: !prod, minify: prod },
      // Webview (browser).
      { entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2022', sourcemap: !prod, minify: prod },
    ];

if (!scriptsOnly) {
  mkdirSync('dist', { recursive: true });
  copyFileSync('webview/style.css', 'dist/webview.css');
}

if (watch) {
  for (const b of builds) (await esbuild.context({ ...b, logLevel: 'info' })).watch();
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...b, logLevel: 'warning' })));
}
