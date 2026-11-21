import { mkdirSync, renameSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseDmx } from '../src/loaders/dmx';
import { parseKV3 } from '../src/loaders/kv3';
import { loaderFor, loadModel, loaders } from '../src/loaders/registry';
import type { ModelData } from '../src/loaders/types';
import { cubeBinary, cubeKv2, writeFixtureTree } from './fixtures';

let dir: string;
const ctx = () => ({
  settings: { contentRoots: [] },
  cacheDir: path.join(os.tmpdir(), 'mb-test-cache'),
  log: () => {},
});
const load = (name: string) => loadModel(path.join(dir, name), ctx());
const mesh = (m: ModelData) => {
  if (m.kind !== 'mesh') throw new Error(`expected mesh, got ${m.kind}`);
  return m;
};
const tris = (m: ModelData) => mesh(m).meshes.reduce((n, p) => n + p.indices.length / 3, 0);

beforeAll(() => {
  dir = writeFixtureTree();
  // a GLB whose texture is missing
  const other = path.join(dir, 'elsewhere');
  mkdirSync(other);
  renameSync(path.join(dir, 'tri_notex.glb'), path.join(other, 'tri_notex.glb'));
});

describe('registry', () => {
  it('picks loaders by longest suffix', () => {
    expect(loaderFor('a/b/foo.vmdl_c')?.id).toBe('vmdl_c');
    expect(loaderFor('foo.VMDL')?.id).toBe('vmdl');
    expect(loaderFor('x.hull.bin.dmx')?.id).toBe('dmx');
    expect(loaderFor('foo.vmdl_c.bak')).toBeUndefined();
  });
  it('has unique ids and extensions', () => {
    const ids = loaders.map((l) => l.id);
    const exts = loaders.flatMap((l) => l.extensions);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(exts).size).toBe(exts.length);
  });
});

describe('DMX keyvalues2', () => {
  it('builds the cube with transforms, materials and a joint', async () => {
    const m = mesh(await load('cube.dmx'));
    expect(m.upAxis).toBe('Z');
    expect(m.meshes).toHaveLength(1);
    const p = m.meshes[0];
    expect(tris(m)).toBe(12); // 6 quads, fan-triangulated
    expect(p.groups.map((g) => [g.material, g.count])).toEqual([
      ['materials/side.vmat', 30],
      ['materials/top.vmat', 6],
    ]);
    // the DmeDag moves the cube +10 on X
    const xs = p.positions.filter((_, i) => i % 3 === 0);
    expect(Math.min(...xs)).toBe(10);
    expect(Math.max(...xs)).toBe(11);
    expect(m.skeleton).toEqual([{ name: 'root_bone', parent: -1, position: [0, 0, 5] }]);
  });
});

describe('DMX binary v9', () => {
  it('reads the same cube, applying a rotated DmeDag', async () => {
    const m = mesh(await load('cube_bin.dmx'));
    expect(tris(m)).toBe(12);
    expect(m.meshes[0].groups).toEqual([{ start: 0, count: 36, material: 'materials/crate.vmat' }]);
    // 90° about Z maps x∈[0,1] → y∈[0,1] and y∈[0,1] → x∈[-1,0]
    const pos = m.meshes[0].positions;
    const xs = pos.filter((_, i) => i % 3 === 0);
    const ys = pos.filter((_, i) => i % 3 === 1);
    expect(Math.min(...xs)).toBeCloseTo(-1);
    expect(Math.max(...xs)).toBeCloseTo(0);
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(Math.max(...ys)).toBeCloseTo(1);
  });

  it('exposes element names as attributes, like keyvalues2', () => {
    const dm = parseDmx(cubeBinary());
    expect(dm.root.type).toBe('DmElement');
    expect(dm.root.str('name')).toBe('root');
    expect(dm.root.element('model')?.name).toBe('cube');
  });

  it('rejects truncated files with a clear error', () => {
    const b = cubeBinary();
    expect(() => parseDmx(b.subarray(0, b.length - 20))).toThrow(/end of file/);
  });

  it('rejects non-DMX input', () => {
    expect(() => parseDmx(new TextEncoder().encode('hello'))).toThrow(/Not a DMX/);
  });

  it('kv2 and binary agree on shared structure', () => {
    const a = parseDmx(new TextEncoder().encode(cubeKv2()));
    const b = parseDmx(cubeBinary());
    const mA = a.root.element('model')!;
    const mB = b.root.element('model')!;
    expect(mA.type).toBe(mB.type);
    const vdA = mA.elements('children')[0].element('shape')!.element('currentState')!;
    const vdB = mB.elements('children')[0].element('shape')!.element('currentState')!;
    expect(Array.from(vdA.floats('position$0')!)).toEqual(Array.from(vdB.floats('position$0')!));
    expect(Array.from(vdA.ints('position$0Indices')!)).toEqual(Array.from(vdB.ints('position$0Indices')!));
  });
});

describe('KV3', () => {
  it('parses objects, arrays, comments, flags and multi-line strings', () => {
    const v = parseKV3(`<!-- kv3 encoding:text:version{x} format:generic:version{y} -->
      { a = 1 b = [ 1.5, -2, true, null, ] c = { d = "e\\"f" } // comment
        /* block */ r = resource:"models/x.vmdl" s = """multi
line""" }`) as Record<string, unknown>;
    expect(v).toEqual({ a: 1, b: [1.5, -2, true, null], c: { d: 'e"f' }, r: 'models/x.vmdl', s: 'multi\nline' });
  });
});

describe('vmdl', () => {
  it('merges mesh files, hides higher LODs, remaps materials and notes missing parts', async () => {
    const m = mesh(await load('cube.vmdl'));
    expect(m.meshes.map((p) => [p.name, !!p.hidden])).toEqual([
      ['cube', false],
      ['cube_lod1', true],
    ]);
    expect(m.meshes[0].groups[0].material).toBe('materials/painted.vmat');
    expect(m.notes?.some((n) => n.includes('missing.dmx'))).toBe(true);
  });
});

describe('obj', () => {
  it('ships the text and its material library', async () => {
    const m = await load('cube.obj');
    expect(m.kind).toBe('obj');
    if (m.kind !== 'obj') return;
    expect(m.text).toMatch(/^f /m);
    expect(m.mtl).toContain('newmtl red');
  });
});

describe('gltf', () => {
  const glbJson = (bytes: Uint8Array) => {
    const b = Buffer.from(bytes);
    expect(b.readUInt32LE(0)).toBe(0x46546c67);
    expect(b.readUInt32LE(8)).toBe(b.length);
    return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
  };

  it('inlines external textures into a valid GLB', async () => {
    const m = await load('tri.glb');
    if (m.kind !== 'gltf') throw new Error('expected gltf');
    const json = glbJson(m.bytes);
    expect(json.images[0].uri).toMatch(/^data:image\/png;base64,/);
    expect(m.notes).toEqual([]);
    // BIN chunk survives the rewrite
    const b = Buffer.from(m.bytes);
    const binStart = 20 + b.readUInt32LE(12);
    expect(b.readUInt32LE(binStart + 4)).toBe(0x004e4942);
    expect(b.readFloatLE(binStart + 8 + 12)).toBe(1);
  });

  it('drops texture slots whose image is missing, with a note', async () => {
    const m = await load('elsewhere/tri_notex.glb');
    if (m.kind !== 'gltf') throw new Error('expected gltf');
    const json = glbJson(m.bytes);
    expect(json.materials[0].pbrMetallicRoughness.baseColorTexture).toBeUndefined();
    expect(m.notes?.[0]).toMatch(/tex\.png/);
  });
});

describe('vmdl_c', () => {
  it('explains how to get Source2Viewer-CLI when it is not configured', async () => {
    await expect(loadModel(path.join(dir, 'x.vmdl_c'), ctx())).rejects.toThrow(/Source2Viewer-CLI/);
  });
});
