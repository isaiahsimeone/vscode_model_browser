// Headless check: run every loader over every model file under a folder and report what happened.
//   npm run sweep -- <folder> [--s2v <path>] [--game <gameinfo.gi>] [--verbose]

import { readdir } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loaderFor, loadModel } from '../src/loaders/registry';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const s2vPath = opt('--s2v');
const gameInfo = opt('--game');
const verbose = args.includes('--verbose');
const root = args.filter((a) => !a.startsWith('--'))[0];
if (!root) {
  console.error('usage: sweep <folder> [--s2v path] [--game gameinfo.gi] [--verbose]');
  process.exit(2);
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && loaderFor(p)) yield p;
  }
}

type Row = { ok: number; empty: number; fail: number; tris: number; ms: number; errors: Map<string, string[]> };
const stats = new Map<string, Row>();

(async () => {
  const cacheDir = path.join(os.tmpdir(), 'model-browser-sweep');
  for await (const file of walk(root)) {
    const id = loaderFor(file)!.id;
    if (id === 'vmdl_c' && !s2vPath) continue;
    const row = stats.get(id) ?? { ok: 0, empty: 0, fail: 0, tris: 0, ms: 0, errors: new Map() };
    stats.set(id, row);
    const t0 = performance.now();
    try {
      const m = await loadModel(file, {
        settings: { s2vPath, gameInfo, contentRoots: [] },
        cacheDir,
        log: () => {},
      });
      let tris = 0;
      let empty = false;
      if (m.kind === 'mesh') {
        tris = m.meshes.reduce((n, p) => n + p.indices.length / 3, 0);
        empty = tris === 0 && !m.skeleton;
      } else if (m.kind === 'gltf') empty = m.bytes.length < 100;
      else empty = !/^f\s/m.test(m.text);
      row.tris += tris;
      if (empty) row.empty++;
      else row.ok++;
      if (verbose) console.log(`${empty ? 'EMPTY' : 'ok   '} ${file} ${tris ? tris + ' tris' : ''} ${(m.notes ?? []).join(' | ')}`);
    } catch (e) {
      row.fail++;
      const msg = ((e as Error).message ?? String(e)).split('\n')[0].replace(/\d+/g, 'N');
      const list = row.errors.get(msg) ?? [];
      list.push(file);
      row.errors.set(msg, list);
      if (verbose) console.log(`FAIL  ${file}: ${(e as Error).message}`);
    }
    row.ms += performance.now() - t0;
  }
  let failed = 0;
  for (const [id, r] of stats) {
    const n = r.ok + r.empty + r.fail;
    console.log(`${id.padEnd(7)} ${n} files: ${r.ok} ok, ${r.empty} empty, ${r.fail} failed, ${r.tris} tris, ${(r.ms / n).toFixed(1)} ms/file`);
    for (const [msg, files] of r.errors) console.log(`    ${files.length}× ${msg}\n        e.g. ${files[0]}`);
    failed += r.fail;
  }
  process.exit(failed ? 1 : 0);
})();
