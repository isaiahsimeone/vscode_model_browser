// Synthetic test models, generated in code so the repo ships no third-party game assets.
// The binary DMX writer here follows the same layout the reader documents (binary v9).

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A unit cube: 8 positions, 6 quad faces, two materials (top face uses "top"). */
export const CUBE = {
  positions: [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ],
  quads: [
    [0, 3, 2, 1], // bottom (z=0)
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
    [4, 5, 6, 7], // top (z=1)
  ],
};

const guid = (n: number) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`;

/** keyvalues2 text DMX of the cube: root → DmeModel → DmeDag (translated +10 on X) → DmeMesh, plus one joint. */
export function cubeKv2(): string {
  // One corner per face-vertex, as Valve's exporters do.
  const corners: number[] = [];
  const sideFaces: number[] = [];
  const topFaces: number[] = [];
  CUBE.quads.forEach((q, f) => {
    const target = f === 5 ? topFaces : sideFaces;
    for (const v of q) {
      target.push(corners.length);
      corners.push(v);
    }
    target.push(-1);
  });
  const vec3s = CUBE.positions.map((p) => `"${p.join(' ')}"`).join(',\n');
  const ints = (a: number[]) => a.map((n) => `"${n}"`).join(',\n');
  return `<!-- dmx encoding keyvalues2 4 format model 22 -->
"DmElement"
{
  "id" "elementid" "${guid(1)}"
  "name" "string" "root"
  "model" "element" "${guid(2)}"
}

"DmeModel"
{
  "id" "elementid" "${guid(2)}"
  "name" "string" "cube"
  "transform" "DmeTransform"
  {
    "id" "elementid" "${guid(3)}"
    "position" "vector3" "0 0 0"
    "orientation" "quaternion" "0 0 0 1"
  }
  "children" "element_array"
  [
    "element" "${guid(4)}",
    "DmeJoint"
    {
      "id" "elementid" "${guid(9)}"
      "name" "string" "root_bone"
      "transform" "DmeTransform"
      {
        "id" "elementid" "${guid(10)}"
        "position" "vector3" "0 0 5"
        "orientation" "quaternion" "0 0 0 1"
      }
      "children" "element_array" [ ]
    }
  ]
  "axisSystem" "DmeAxisSystem"
  {
    "id" "elementid" "${guid(11)}"
    "upAxis" "int" "3"
  }
}

"DmeDag"
{
  "id" "elementid" "${guid(4)}"
  "name" "string" "cube_dag"
  "transform" "DmeTransform"
  {
    "id" "elementid" "${guid(5)}"
    "position" "vector3" "10 0 0"
    "orientation" "quaternion" "0 0 0 1"
  }
  "shape" "DmeMesh"
  {
    "id" "elementid" "${guid(6)}"
    "name" "string" "cube_mesh"
    "currentState" "element" "${guid(7)}"
    "faceSets" "element_array"
    [
      "DmeFaceSet"
      {
        "id" "elementid" "${guid(12)}"
        "faces" "int_array" [ ${ints(sideFaces)} ]
        "material" "DmeMaterial" { "id" "elementid" "${guid(13)}" "mtlName" "string" "materials/side.vmat" }
      },
      "DmeFaceSet"
      {
        "id" "elementid" "${guid(14)}"
        "faces" "int_array" [ ${ints(topFaces)} ]
        "material" "DmeMaterial" { "id" "elementid" "${guid(15)}" "mtlName" "string" "materials/top.vmat" }
      }
    ]
  }
  "children" "element_array" [ ]
}

"DmeVertexData"
{
  "id" "elementid" "${guid(7)}"
  "name" "string" "bind"
  "vertexFormat" "string_array" [ "position$0" ]
  "position$0" "vector3_array" [ ${vec3s} ]
  "position$0Indices" "int_array" [ ${ints(corners)} ]
}
`;
}

// --- binary v9 writer (enough of the format for tests) -----------------------------------------------------------

type BinVal =
  | { t: 'element'; v: number | null }
  | { t: 'int'; v: number }
  | { t: 'string'; v: string }
  | { t: 'vector3'; v: number[] }
  | { t: 'quaternion'; v: number[] }
  | { t: 'element_array'; v: number[] }
  | { t: 'int_array'; v: number[] }
  | { t: 'string_array'; v: string[] }
  | { t: 'vector3_array'; v: number[][] };

interface BinEl {
  type: string;
  name: string;
  attrs: [string, BinVal][];
}

const TYPE_ID: Record<string, number> = { element: 1, int: 2, string: 5, vector3: 10, quaternion: 13 };

export function writeBinaryDmx(elements: BinEl[]): Uint8Array {
  const strings: string[] = [];
  const sidx = (s: string) => {
    let i = strings.indexOf(s);
    if (i < 0) i = strings.push(s) - 1;
    return i;
  };
  for (const e of elements) {
    sidx(e.type);
    sidx(e.name);
    for (const [k, v] of e.attrs) {
      sidx(k);
      if (v.t === 'string') sidx(v.v);
    }
  }
  const parts: number[] = [];
  const u8 = (n: number) => parts.push(n & 0xff);
  const i32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(n);
    parts.push(...b);
  };
  const f32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(n);
    parts.push(...b);
  };
  const cstr = (s: string) => {
    parts.push(...Buffer.from(s, 'utf8'), 0);
  };

  cstr('<!-- dmx encoding binary 9 format model 22 -->\n');
  i32(0); // no prefix elements
  i32(strings.length);
  strings.forEach(cstr);
  i32(elements.length);
  elements.forEach((e, n) => {
    i32(sidx(e.type));
    i32(sidx(e.name));
    for (let k = 0; k < 16; k++) u8(k === 0 ? n + 1 : 0);
  });
  for (const e of elements) {
    i32(e.attrs.length);
    for (const [k, v] of e.attrs) {
      i32(sidx(k));
      const arr = v.t.endsWith('_array');
      const base = arr ? v.t.slice(0, -6) : v.t;
      u8(TYPE_ID[base] + (arr ? 32 : 0));
      switch (v.t) {
        case 'element':
          i32(v.v ?? -1);
          break;
        case 'int':
          i32(v.v);
          break;
        case 'string':
          i32(sidx(v.v));
          break;
        case 'vector3':
        case 'quaternion':
          v.v.forEach(f32);
          break;
        case 'element_array':
        case 'int_array':
          i32(v.v.length);
          v.v.forEach(i32);
          break;
        case 'string_array':
          i32(v.v.length);
          v.v.forEach(cstr);
          break;
        case 'vector3_array':
          i32(v.v.length);
          v.v.forEach((p) => p.forEach(f32));
          break;
      }
    }
  }
  return Uint8Array.from(parts);
}

/** The same cube (without the joint), as binary v9. */
export function cubeBinary(): Uint8Array {
  const corners: number[] = [];
  const faces: number[] = [];
  CUBE.quads.forEach((q) => {
    for (const v of q) {
      faces.push(corners.length);
      corners.push(v);
    }
    faces.push(-1);
  });
  // indices: 0 root, 1 model, 2 model xform, 3 dag, 4 dag xform, 5 mesh, 6 vertex data, 7 faceset, 8 material
  return writeBinaryDmx([
    { type: 'DmElement', name: 'root', attrs: [['model', { t: 'element', v: 1 }]] },
    { type: 'DmeModel', name: 'cube', attrs: [['transform', { t: 'element', v: 2 }], ['children', { t: 'element_array', v: [3] }]] },
    { type: 'DmeTransform', name: '', attrs: [['position', { t: 'vector3', v: [0, 0, 0] }], ['orientation', { t: 'quaternion', v: [0, 0, 0, 1] }]] },
    { type: 'DmeDag', name: 'cube_dag', attrs: [['transform', { t: 'element', v: 4 }], ['shape', { t: 'element', v: 5 }]] },
    // 90° about Z: (x, y, z) → (-y, x, z)
    { type: 'DmeTransform', name: '', attrs: [['position', { t: 'vector3', v: [0, 0, 0] }], ['orientation', { t: 'quaternion', v: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }]] },
    { type: 'DmeMesh', name: 'cube_mesh', attrs: [['currentState', { t: 'element', v: 6 }], ['faceSets', { t: 'element_array', v: [7] }]] },
    {
      type: 'DmeVertexData',
      name: 'bind',
      attrs: [
        ['vertexFormat', { t: 'string_array', v: ['position$0'] }],
        ['position$0', { t: 'vector3_array', v: CUBE.positions }],
        ['position$0Indices', { t: 'int_array', v: corners }],
      ],
    },
    { type: 'DmeFaceSet', name: 'fs', attrs: [['faces', { t: 'int_array', v: faces }], ['material', { t: 'element', v: 8 }]] },
    { type: 'DmeMaterial', name: 'mat', attrs: [['mtlName', { t: 'string', v: 'materials/crate.vmat' }]] },
  ]);
}

export const CUBE_OBJ = `# cube
mtllib cube.mtl
${CUBE.positions.map((p) => `v ${p.join(' ')}`).join('\n')}
usemtl red
${CUBE.quads.map((q) => `f ${q.map((i) => i + 1).join(' ')}`).join('\n')}
`;

/** A minimal GLB: one triangle, one material whose base colour texture is an external "tex.png". */
export function triangleGlb(): Uint8Array {
  const bin = Buffer.alloc(36);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => bin.writeFloatLE(v, i * 4));
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'tri' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0 }],
    images: [{ uri: 'tex.png' }],
    buffers: [{ byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  };
  let text = Buffer.from(JSON.stringify(json));
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bin.length, 8);
  const chunk = (type: number, data: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  return new Uint8Array(Buffer.concat([header, chunk(0x4e4f534a, text), chunk(0x004e4942, bin)]));
}

// 1×1 PNG
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

/** Writes a small content tree to a temp dir:
 *    content/models/props/cube.dmx (kv2), cube_bin.dmx, cube.vmdl, cube.obj + cube.mtl, tri.glb (+ tex.png)  */
export function writeFixtureTree(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mb-test-'));
  const dir = path.join(root, 'content', 'models', 'props');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'cube.dmx'), cubeKv2());
  writeFileSync(path.join(dir, 'cube_bin.dmx'), cubeBinary());
  writeFileSync(
    path.join(dir, 'cube.vmdl'),
    `<!-- kv3 encoding:text:version{e21c7f3c-8a33-41c5-9977-a76d3a32aa0d} format:modeldoc28:version{fb63b6ca-f435-4aa0-a2c7-c66ddc651dca} -->
{
  rootNode = {
    _class = "RootNode"
    children = [
      { _class = "RenderMeshList" children = [
          { _class = "RenderMeshFile" name = "cube" filename = "models/props/cube.dmx" },
          { _class = "RenderMeshFile" name = "cube_lod1" filename = "models/props/cube_bin.dmx" },
          { _class = "RenderMeshFile" name = "gone" filename = "models/props/missing.dmx" },
      ] },
      { _class = "LODGroupList" children = [
          { _class = "LODGroup" switch_threshold = 0.0 meshes = [ "cube", "gone" ] },
          { _class = "LODGroup" switch_threshold = 25.0 meshes = [ "cube_lod1" ] },
      ] },
      { _class = "MaterialGroupList" children = [
          { _class = "DefaultMaterialGroup" remaps = [ ] },
          { _class = "BaseMaterialRemap" from = "side.vmat" to = "materials/painted.vmat" },
      ] },
      // a comment, and a multi-line string
      { _class = "Note" text = """line one
line two""" },
    ]
  }
}
`,
  );
  writeFileSync(path.join(dir, 'cube.obj'), CUBE_OBJ);
  writeFileSync(path.join(dir, 'cube.mtl'), 'newmtl red\nKd 1 0 0\n');
  writeFileSync(path.join(dir, 'tri.glb'), triangleGlb());
  writeFileSync(path.join(dir, 'tex.png'), PNG_1PX);
  writeFileSync(path.join(dir, 'tri_notex.glb'), triangleGlb());
  return dir;
}
