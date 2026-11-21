// .vmdl (ModelDoc source): a KV3 tree whose RenderMeshFile nodes point at mesh files (usually .dmx) by
// content-relative path ("models/props/foo_mesh.dmx"). We resolve those against a content root, load each one
// through the registry, and merge the parts. LOD meshes other than LOD0 and non-default body-group choices are
// included but start hidden.

import { access, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { kv3Objects, parseKV3, type KV3 } from './kv3';
import type { Bone, LoadContext, MeshPart, ModelData, ModelLoader } from './types';

type Obj = { [k: string]: KV3 };
const str = (v: KV3 | undefined) => (typeof v === 'string' ? v : undefined);
const arr = (v: KV3 | undefined) => (Array.isArray(v) ? v : []);

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Find the folder that `rel` (e.g. "models/foo/x.dmx") lives under: an ancestor of the .vmdl, or a configured root. */
export async function resolveContentPath(fromFile: string, rel: string, roots: string[]): Promise<string | undefined> {
  const norm = rel.replace(/\\/g, '/');
  // Same folder as the vmdl first (decompiled files often sit together).
  const sibling = path.join(path.dirname(fromFile), path.basename(norm));
  let dir = path.dirname(fromFile);
  for (;;) {
    const candidate = path.join(dir, norm);
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const root of roots) {
    const candidate = path.join(root, norm);
    if (await exists(candidate)) return candidate;
  }
  if (await exists(sibling)) return sibling;
  return undefined;
}

interface Plan {
  hiddenMeshes: Set<string>;
  notes: string[];
}

/** Which mesh names should start hidden: higher LODs, and body-group choices other than the first. */
function visibilityPlan(root: KV3): Plan {
  const hidden = new Set<string>();
  const shown = new Set<string>();
  const notes: string[] = [];
  const meshNames = (o: Obj) => [
    ...arr(o.mesh_references).map((r) => (typeof r === 'string' ? r : str((r as Obj)?.mesh_name))),
    ...arr(o.meshes).map((r) => (typeof r === 'string' ? r : str((r as Obj)?.mesh_name))),
  ].filter((n): n is string => !!n);

  const lods: { threshold: number; meshes: string[] }[] = [];
  for (const o of kv3Objects(root)) {
    if (o._class === 'LODGroup') lods.push({ threshold: Number(o.switch_threshold ?? 0), meshes: meshNames(o) });
    if (o._class === 'BodyGroup') {
      const choices = arr(o.children).filter((c) => (c as Obj)?._class === 'BodyGroupChoice') as Obj[];
      choices.forEach((c, idx) => meshNames(c).forEach((m) => (idx === 0 ? shown : hidden).add(m)));
      if (choices.length > 1) notes.push(`Body group "${str(o.name) ?? '?'}": showing "${str(choices[0].name) ?? 'first'}" (toggle others in Parts).`);
    }
  }
  if (lods.length > 1) {
    lods.sort((a, b) => a.threshold - b.threshold);
    const lod0 = new Set(lods[0].meshes);
    for (const l of lods.slice(1)) for (const m of l.meshes) if (!lod0.has(m)) hidden.add(m);
  }
  for (const m of shown) hidden.delete(m);
  return { hiddenMeshes: hidden, notes };
}

export async function loadVmdl(file: string, ctx: LoadContext): Promise<ModelData> {
  const root = parseKV3(await readFile(file, 'utf8'));
  const plan = visibilityPlan(root);
  const notes: string[] = [...plan.notes];
  const meshes: MeshPart[] = [];
  let skeleton: Bone[] | undefined;
  let upAxis: 'Y' | 'Z' = 'Z';
  let found = 0;

  for (const o of kv3Objects(root)) {
    if (o._class !== 'RenderMeshFile') continue;
    const rel = str(o.filename);
    if (!rel) continue;
    found++;
    const name = str(o.name) ?? path.basename(rel);
    const target = await resolveContentPath(file, rel, ctx.settings.contentRoots);
    if (!target) {
      notes.push(`Missing mesh file: ${rel}`);
      continue;
    }
    let part: ModelData;
    try {
      part = await ctx.loadAs(target);
    } catch (e) {
      notes.push(`${rel}: ${(e as Error).message}`);
      continue;
    }
    if (part.kind !== 'mesh') {
      notes.push(`${rel}: ${part.kind} meshes inside a .vmdl are not merged yet`);
      continue;
    }
    upAxis = part.upAxis;
    const scale = typeof o.import_scale === 'number' && o.import_scale !== 1 ? o.import_scale : 1;
    const hidden = plan.hiddenMeshes.has(name);
    for (const m of part.meshes) {
      if (scale !== 1) for (let i = 0; i < m.positions.length; i++) m.positions[i] *= scale;
      meshes.push({ ...m, name: part.meshes.length > 1 ? `${name}/${m.name}` : name, hidden: hidden || m.hidden });
    }
    if (!skeleton && part.skeleton) skeleton = part.skeleton;
  }

  // Material remaps change which material a mesh uses in game; show the in-game names.
  const remaps = new Map<string, string>();
  for (const o of kv3Objects(root)) {
    if (o._class === 'BaseMaterialRemap' || o._class === 'MaterialRemap') {
      const from = str(o.from), to = str(o.to);
      if (from && to) remaps.set(from, to);
    }
  }
  if (remaps.size)
    for (const m of meshes)
      for (const g of m.groups) {
        const key = [...remaps.keys()].find((k) => g.material === k || path.basename(g.material) === path.basename(k));
        if (key) g.material = remaps.get(key)!;
      }

  if (!found) notes.push('This .vmdl has no RenderMeshFile entries.');
  return { kind: 'mesh', meshes, skeleton, upAxis, notes };
}

export const vmdlLoader: ModelLoader = {
  id: 'vmdl',
  label: 'Source 2 model (source)',
  extensions: ['.vmdl'],
  load: loadVmdl,
};
