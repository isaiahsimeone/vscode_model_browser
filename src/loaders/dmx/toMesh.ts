// Datamodel → renderable meshes + skeleton.
//
// A model DMX looks like: root.model → DmeModel { transform, children: [DmeDag | DmeJoint …], jointList }.
// A DmeDag's `shape` is a DmeMesh, whose vertex data (currentState / bindState / baseStates[0]) holds per-stream
// arrays ("position$0") and per-corner index arrays ("position$0Indices"). Each DmeFaceSet lists polygons as
// corner indices terminated by -1, plus a DmeMaterial.

import type { Bone, MaterialGroup, MeshPart, ModelData } from '../types';
import type { Datamodel, DmElement } from './datamodel';

type Mat4 = Float64Array; // column-major 4x4

const identity = (): Mat4 => {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

function fromTransform(t: DmElement | null): Mat4 {
  const m = identity();
  if (!t) return m;
  const p = t.vec('position') ?? [0, 0, 0];
  const q = t.vec('orientation') ?? [0, 0, 0, 1];
  const s = t.get('scale');
  const sc = typeof s === 'number' ? s : 1;
  const [x, y, z, w] = q;
  m[0] = (1 - 2 * (y * y + z * z)) * sc;
  m[1] = 2 * (x * y + z * w) * sc;
  m[2] = 2 * (x * z - y * w) * sc;
  m[4] = 2 * (x * y - z * w) * sc;
  m[5] = (1 - 2 * (x * x + z * z)) * sc;
  m[6] = 2 * (y * z + x * w) * sc;
  m[8] = 2 * (x * z + y * w) * sc;
  m[9] = 2 * (y * z - x * w) * sc;
  m[10] = (1 - 2 * (x * x + y * y)) * sc;
  m[12] = p[0];
  m[13] = p[1];
  m[14] = p[2];
  return m;
}

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

const isIdentity = (m: Mat4) => m.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9);

/** First stream present out of several historical names. */
function stream(vd: DmElement, names: string[]): { data: Float32Array; indices: Int32Array; name: string } | undefined {
  const fmt = vd.strings('vertexFormat');
  const candidates = [...names.filter((n) => fmt.includes(n)), ...names];
  for (const n of candidates) {
    const data = vd.floats(n);
    const indices = vd.ints(n + 'Indices');
    if (data && indices) return { data, indices, name: n };
  }
  return undefined;
}

function meshFromDag(dag: DmElement, mesh: DmElement, world: Mat4): MeshPart | string {
  const vd =
    mesh.element('currentState') ?? mesh.element('bindState') ?? mesh.elements('baseStates')[0] ?? null;
  if (!vd) return `${mesh.name}: no vertex data`;
  const pos = stream(vd, ['position$0', 'positions']);
  if (!pos) return `${mesh.name}: no positions`;
  const nrm = stream(vd, ['normal$0', 'normals']);
  const uv = stream(vd, ['texcoord$0', 'textureCoordinates']);
  const flipV = vd.get('flipVCoordinates') === true;

  const corners = pos.indices.length;
  const positions = new Float32Array(corners * 3);
  const ident = isIdentity(world);
  for (let c = 0; c < corners; c++) {
    const i = pos.indices[c] * 3;
    const x = pos.data[i], y = pos.data[i + 1], z = pos.data[i + 2];
    if (ident) {
      positions[c * 3] = x;
      positions[c * 3 + 1] = y;
      positions[c * 3 + 2] = z;
    } else {
      positions[c * 3] = world[0] * x + world[4] * y + world[8] * z + world[12];
      positions[c * 3 + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
      positions[c * 3 + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
    }
  }

  let normals: Float32Array | undefined;
  if (nrm && nrm.indices.length === corners) {
    normals = new Float32Array(corners * 3);
    for (let c = 0; c < corners; c++) {
      const i = nrm.indices[c] * 3;
      const x = nrm.data[i], y = nrm.data[i + 1], z = nrm.data[i + 2];
      if (ident) {
        normals[c * 3] = x;
        normals[c * 3 + 1] = y;
        normals[c * 3 + 2] = z;
      } else {
        let nx = world[0] * x + world[4] * y + world[8] * z;
        let ny = world[1] * x + world[5] * y + world[9] * z;
        let nz = world[2] * x + world[6] * y + world[10] * z;
        const len = Math.hypot(nx, ny, nz) || 1;
        normals[c * 3] = nx / len;
        normals[c * 3 + 1] = ny / len;
        normals[c * 3 + 2] = nz / len;
      }
    }
  }

  let uvs: Float32Array | undefined;
  if (uv && uv.indices.length === corners) {
    uvs = new Float32Array(corners * 2);
    for (let c = 0; c < corners; c++) {
      const i = uv.indices[c] * 2;
      uvs[c * 2] = uv.data[i];
      uvs[c * 2 + 1] = flipV ? 1 - uv.data[i + 1] : uv.data[i + 1];
    }
  }

  const tris: number[] = [];
  const groups: MaterialGroup[] = [];
  for (const fs of mesh.elements('faceSets')) {
    const faces = fs.ints('faces');
    if (!faces) continue;
    const start = tris.length;
    let polyStart = 0;
    for (let i = 0; i <= faces.length; i++) {
      if (i === faces.length || faces[i] < 0) {
        // fan-triangulate faces[polyStart..i)
        for (let k = polyStart + 1; k + 1 < i; k++) {
          const a = faces[polyStart], b = faces[k], c = faces[k + 1];
          if (a < corners && b < corners && c < corners) tris.push(a, b, c);
        }
        polyStart = i + 1;
      }
    }
    const mat = fs.element('material');
    const material = mat?.str('mtlName') || mat?.name || fs.name || 'default';
    if (tris.length > start) groups.push({ start, count: tris.length - start, material });
  }

  return {
    name: dag.name || mesh.name,
    positions,
    normals,
    uvs,
    indices: Uint32Array.from(tris),
    groups,
  };
}

export function datamodelToModel(dm: Datamodel): ModelData {
  const notes: string[] = [];
  const meshes: MeshPart[] = [];
  const bones: Bone[] = [];
  const seenMeshes = new Set<DmElement>();
  const visited = new Set<DmElement>();

  const model = dm.root.element('model') ?? dm.root.element('skeleton') ?? dm.elements.find((e) => e.type === 'DmeModel') ?? null;

  const walk = (node: DmElement, parentWorld: Mat4, parentBone: number) => {
    if (visited.has(node)) return;
    visited.add(node);
    const world = mul(parentWorld, fromTransform(node.element('transform')));
    let boneIndex = parentBone;
    if (node.type === 'DmeJoint') {
      bones.push({ name: node.name, parent: parentBone, position: [world[12], world[13], world[14]] });
      boneIndex = bones.length - 1;
    }
    const shape = node.element('shape');
    if (shape && shape.type === 'DmeMesh' && !seenMeshes.has(shape)) {
      seenMeshes.add(shape);
      const part = meshFromDag(node, shape, world);
      if (typeof part === 'string') notes.push(part);
      else meshes.push(part);
    }
    for (const child of node.elements('children')) walk(child, world, boneIndex);
  };

  if (model) walk(model, identity(), -1);

  // Meshes not reachable from the model (unusual, but keeps odd files viewable).
  for (const el of dm.elements) {
    if (el.type !== 'DmeMesh' || seenMeshes.has(el)) continue;
    seenMeshes.add(el);
    const part = meshFromDag(el, el, identity());
    if (typeof part === 'string') notes.push(part);
    else meshes.push(part);
  }

  const axis = model?.element('axisSystem');
  const up = axis?.get('upAxis');
  const upAxis = up === 2 ? 'Y' : 'Z';

  if (!meshes.length) {
    if (bones.length) notes.push('No mesh in this file (animation or skeleton only); showing the skeleton.');
    else if (dm.elements.some((e) => e.type === 'DmeChannelsClip' || e.type === 'DmeAnimationList'))
      notes.push('Animation data only; nothing to draw.');
    else notes.push('No mesh or skeleton found in this file.');
  }

  return { kind: 'mesh', meshes, skeleton: bones.length ? bones : undefined, upAxis, notes };
}
