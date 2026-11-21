// Dev harness: serves the real webview bundle in a normal browser and feeds it models from the real loaders,
// so the viewer can be checked (and screenshotted) without launching VS Code.
//   npm run preview -- [--port 5178] [--s2v path] [--game gameinfo.gi]
//   then open http://localhost:5178/?file=/abs/path/to/model.dmx

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { loaderFor, loadModel } from '../src/loaders/registry';

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = +(opt('--port') ?? 5178);
const settings = { s2vPath: opt('--s2v'), gameInfo: opt('--game'), contentRoots: [] as string[] };
const dist = path.join(__dirname, '..', 'dist');

/** JSON with typed arrays encoded as base64, revived in the page. */
function encode(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    ArrayBuffer.isView(x) && !(x instanceof DataView)
      ? { __ta: x.constructor.name, b64: Buffer.from(x.buffer, x.byteOffset, x.byteLength).toString('base64') }
      : x,
  );
}

const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/webview.css">
<style>body{--vscode-editor-background:#1f1f1f;--vscode-foreground:#ccc;--vscode-sideBar-background:#181818;--vscode-panel-border:#2b2b2b}</style>
</head><body><div id="app"></div><script>
const file = new URLSearchParams(location.search).get('file');
const revive = (_k, x) => x && x.__ta ? new globalThis[x.__ta](Uint8Array.from(atob(x.b64), c => c.charCodeAt(0)).buffer) : x;
window.__host = {
  getState: () => undefined, setState: () => {},
  postMessage: async (m) => {
    if (m.type !== 'ready' && m.type !== 'reload') return console.log('host <-', m);
    const name = file.split('/').pop();
    window.postMessage({ type: 'loading', file: name });
    const r = await fetch('/model?file=' + encodeURIComponent(file));
    const msg = JSON.parse(await r.text(), revive);
    window.postMessage(msg);
    window.__loaded = msg.type;
  },
};
</script><script src="/webview.js"></script></body></html>`;

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    } else if (url.pathname === '/webview.js' || url.pathname === '/webview.css') {
      const type = url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css';
      res.writeHead(200, { 'content-type': type }).end(readFileSync(path.join(dist, url.pathname)));
    } else if (url.pathname === '/model') {
      const file = url.searchParams.get('file')!;
      const t0 = Date.now();
      let msg: unknown;
      try {
        const data = await loadModel(file, { settings, cacheDir: path.join(os.tmpdir(), 'model-browser-preview'), log: (m) => console.log(m) });
        msg = { type: 'model', file: path.basename(file), loader: loaderFor(file)?.label, data, ms: Date.now() - t0 };
      } catch (e) {
        msg = { type: 'error', file: path.basename(file), message: (e as Error).message };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(encode(msg));
    } else res.writeHead(404).end();
  } catch (e) {
    res.writeHead(500).end(String(e));
  }
}).listen(port, () => console.log(`preview on http://localhost:${port}/?file=<path>`));
