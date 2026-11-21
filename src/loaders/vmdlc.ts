// .vmdl_c (compiled Source 2 model): converted to .glb by the Source 2 Viewer CLI (ValveResourceFormat), then
// rendered like any glTF. Results are cached by path + size + mtime so re-opening is instant.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { LoadContext, ModelData, ModelLoader } from './types';

/** Bump when the s2v arguments change, so old cached conversions are not reused. */
const CACHE_VERSION = 3;

export class MissingToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingToolError';
  }
}

function run(cmd: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    // s2v writes exceptions.txt into its working directory, so run it inside the temp folder.
    const child = spawn(cmd, args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'EACCES') reject(new MissingToolError(`Cannot run Source2Viewer-CLI at ${cmd} (${e.code})`));
      else reject(e);
    });
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

export async function convertWithS2V(file: string, ctx: LoadContext): Promise<ModelData> {
  const s2v = ctx.settings.s2vPath;
  if (!s2v) {
    throw new MissingToolError(
      'Viewing .vmdl_c needs the Source 2 Viewer CLI. Download Source2Viewer-CLI from github.com/ValveResourceFormat/ValveResourceFormat/releases and set "modelBrowser.s2vPath".',
    );
  }
  const st = await stat(file);
  const key = createHash('sha1')
    .update([CACHE_VERSION, path.resolve(file), st.size, st.mtimeMs, ctx.settings.gameInfo ?? '', s2v].join('|'))
    .digest('hex')
    .slice(0, 16);
  const cached = path.join(ctx.cacheDir, 'vmdl_c', `${key}.glb`);
  const cachedNotes = cached + '.notes.json';
  try {
    const bytes = new Uint8Array(await readFile(cached));
    const notes = JSON.parse(await readFile(cachedNotes, 'utf8')) as string[];
    return { kind: 'gltf', bytes, upAxis: 'Y', notes };
  } catch {
    /* not cached */
  }

  const work = path.join(ctx.cacheDir, 'vmdl_c', `${key}.tmp`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const out = path.join(work, 'model.glb');
  const args = ['-i', path.resolve(file), '-o', out, '-d', '--gltf_export_format', 'glb', '--gltf_export_materials', '--gltf_textures_adapt', '--gltf_export_animations'];
  if (ctx.settings.gameInfo) args.push('--game', ctx.settings.gameInfo);
  ctx.log(`s2v ${args.join(' ')}`);
  const { code, output } = await run(path.resolve(s2v), args, work, ctx.signal);
  ctx.log(output.trim());

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(out));
  } catch {
    // s2v often exits 0 and logs the real failure to exceptions.txt; prefer that over the tail of stdout.
    const exception = await readFile(path.join(work, 'exceptions.txt'), 'utf8').then(
      (t) => /Exception: .*/.exec(t)?.[0],
      () => undefined,
    );
    await rm(work, { recursive: true, force: true });
    const detail = exception ?? output.trim().split('\n').slice(-5).join('\n');
    throw new Error(`Source2Viewer-CLI could not convert this model (exit ${code}).\n${detail}`);
  }

  const missing = [...new Set([...output.matchAll(/Failed to load "([^"]+)"/g)].map((m) => m[1]))];
  const list = (xs: string[]) => xs.slice(0, 6).join(', ') + (xs.length > 6 ? ', …' : '');
  const isMaterial = (p: string) => /\.(vmat|vtex)_c$/i.test(p);
  const mats = missing.filter(isMaterial);
  const other = missing.filter((p) => !isMaterial(p));
  const notes = ['Converted with Source 2 Viewer CLI'];
  if (mats.length) notes.push(`${mats.length} material(s) not found, shown untextured: ${list(mats)}`);
  if (other.length) notes.push(`${other.length} other resource(s) not found: ${list(other)}`);
  if (missing.length && !ctx.settings.gameInfo) notes.push('Set "modelBrowser.gameInfo" to a gameinfo.gi so resources can be found in the game files.');
  await writeFile(cached, bytes);
  await writeFile(cachedNotes, JSON.stringify(notes));
  await rm(work, { recursive: true, force: true });
  return { kind: 'gltf', bytes, upAxis: 'Y', notes };
}

export const vmdlcLoader: ModelLoader = {
  id: 'vmdl_c',
  label: 'Source 2 model (compiled)',
  extensions: ['.vmdl_c'],
  load: convertWithS2V,
};
