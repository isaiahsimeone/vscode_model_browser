import { readFile } from 'node:fs/promises';
import type { ModelLoader } from './types';

// Parsing happens in the webview with three's PLYLoader (it handles all three encodings, vertex colours and
// arbitrary extra properties). Here we only validate the header and summarise it for the Notes panel.

export interface PlyHeader {
  format: string;
  elements: { name: string; count: number; properties: string[] }[];
}

export function parsePlyHeader(buf: Buffer): PlyHeader {
  const end = buf.indexOf('end_header');
  if (buf.subarray(0, 3).toString('latin1') !== 'ply' || end < 0) throw new Error('Not a PLY file (missing "ply" … "end_header")');
  const header: PlyHeader = { format: '', elements: [] };
  for (const line of buf.subarray(0, end).toString('latin1').split(/\r?\n/)) {
    const [kw, ...rest] = line.trim().split(/\s+/);
    if (kw === 'format') header.format = rest[0];
    else if (kw === 'element') header.elements.push({ name: rest[0], count: +rest[1], properties: [] });
    else if (kw === 'property') header.elements.at(-1)?.properties.push(rest.at(-1)!);
  }
  if (!['ascii', 'binary_little_endian', 'binary_big_endian'].includes(header.format)) {
    throw new Error(`Unsupported PLY format "${header.format}"`);
  }
  return header;
}

export const plyLoader: ModelLoader = {
  id: 'ply',
  label: 'PLY',
  extensions: ['.ply'],
  async load(file) {
    const buf = await readFile(file);
    const h = parsePlyHeader(buf);
    const vertex = h.elements.find((e) => e.name === 'vertex');
    const faces = h.elements.find((e) => e.name === 'face')?.count ?? 0;
    const has = (...p: string[]) => p.every((x) => vertex?.properties.includes(x));
    const notes = [
      `PLY ${h.format.replace(/_/g, ' ')}: ${vertex?.count ?? 0} vertices, ${faces} faces`,
      ...(faces ? [] : ['No faces: shown as a point cloud.']),
      ...(has('red', 'green', 'blue') ? ['Has vertex colours.'] : []),
    ];
    return { kind: 'ply', bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), pointCloud: !faces, notes };
  },
};
