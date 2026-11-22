import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ModelLoader, MeshPart } from './types';

// Binary STL: 80-byte header, uint32 triangle count, then 50 bytes per triangle
// (normal, 3 vertices, uint16 attribute). ASCII STL: "solid … facet … vertex x y z … endsolid".
// Binary files may also start with "solid", so the size check decides.

function isBinary(buf: Buffer): boolean {
  if (buf.length < 84) return false;
  const count = buf.readUInt32LE(80);
  return 84 + count * 50 === buf.length;
}

function readBinary(buf: Buffer): Float32Array {
  const count = buf.readUInt32LE(80);
  const out = new Float32Array(count * 9);
  for (let t = 0; t < count; t++) {
    const o = 84 + t * 50 + 12; // skip the stored normal; many exporters write zeros
    for (let k = 0; k < 9; k++) out[t * 9 + k] = buf.readFloatLE(o + k * 4);
  }
  return out;
}

function readAscii(text: string): Float32Array {
  const coords: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m; (m = re.exec(text)); ) coords.push(+m[1], +m[2], +m[3]);
  if (coords.length % 9) throw new Error('ASCII STL has a facet without exactly 3 vertices');
  return Float32Array.from(coords);
}

export const stlLoader: ModelLoader = {
  id: 'stl',
  label: 'STL',
  extensions: ['.stl'],
  async load(file) {
    const buf = await readFile(file);
    const binary = isBinary(buf);
    if (!binary && !/^\s*solid/.test(buf.subarray(0, 256).toString('latin1'))) {
      throw new Error('Not an STL file: size does not match a binary STL and it does not start with "solid"');
    }
    const positions = binary ? readBinary(buf) : readAscii(buf.toString('latin1'));
    const indices = new Uint32Array(positions.length / 3).map((_, i) => i);
    const part: MeshPart = {
      name: path.basename(file, path.extname(file)),
      positions,
      indices,
      groups: indices.length ? [{ start: 0, count: indices.length, material: 'stl' }] : [],
    };
    return {
      kind: 'mesh',
      meshes: [part],
      upAxis: 'Z', // the 3D-printing convention; the toolbar's up-axis button swaps it
      notes: [binary ? 'Binary STL' : 'ASCII STL', ...(indices.length ? [] : ['This STL has no triangles.'])],
    };
  },
};
