import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ModelLoader } from './types';

/** glTF is rendered by three's GLTFLoader in the webview. The webview cannot read the disk, so any external
 *  files the model references (textures, .bin buffers) are read here and inlined as data: URIs. */

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.bin': 'application/octet-stream',
};

interface GltfJson {
  images?: { uri?: string; mimeType?: string }[];
  textures?: unknown[];
  materials?: unknown[];
  buffers?: { uri?: string; byteLength: number }[];
  [k: string]: unknown;
}

/** Inline external URIs. Returns the names of files that could not be found. Texture slots that point at a
 *  missing image are removed, so the model falls back to flat colours instead of failing to fetch. */
async function inlineExternal(json: GltfJson, dir: string): Promise<string[]> {
  const missing: string[] = [];
  const missingImages = new Set<number>();
  const entries: [{ uri?: string; mimeType?: string }, number | undefined][] = [
    ...(json.images ?? []).map((e, i) => [e, i] as [typeof e, number]),
    ...(json.buffers ?? []).map((e) => [e, undefined] as [typeof e, undefined]),
  ];
  for (const [e, imageIndex] of entries) {
    if (!e.uri || e.uri.startsWith('data:')) continue;
    const rel = decodeURIComponent(e.uri);
    try {
      const bytes = await readFile(path.resolve(dir, rel));
      const mime = e.mimeType || MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream';
      e.uri = `data:${mime};base64,${bytes.toString('base64')}`;
    } catch {
      missing.push(rel);
      if (imageIndex !== undefined) missingImages.add(imageIndex);
    }
  }
  if (missingImages.size) {
    const textures = (json.textures ?? []) as { source?: number }[];
    const dead = new Set(textures.flatMap((t, i) => (t.source !== undefined && missingImages.has(t.source) ? [i] : [])));
    const strip = (o: unknown): void => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (k.endsWith('Texture') && v && typeof v === 'object' && dead.has((v as { index: number }).index)) delete (o as Record<string, unknown>)[k];
        else strip(v);
      }
    };
    strip(json.materials);
  }
  return missing;
}

const pad4 = (n: number) => (n + 3) & ~3;

/** Rebuild a GLB around a new JSON chunk, keeping the BIN chunk as is. */
function rewriteGlb(buf: Buffer, json: GltfJson): Buffer {
  const jsonLen = buf.readUInt32LE(12);
  const rest = buf.subarray(20 + jsonLen); // BIN chunk (header included), if any
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const padded = Buffer.alloc(pad4(text.length), 0x20);
  text.copy(padded);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + padded.length + rest.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16); // "JSON"
  return Buffer.concat([header, padded, rest]);
}

export const gltfLoader: ModelLoader = {
  id: 'gltf',
  label: 'glTF',
  extensions: ['.glb', '.gltf'],
  async load(file) {
    let buf: Buffer = await readFile(file);
    const dir = path.dirname(file);
    const notes: string[] = [];
    const isGlb = buf.length >= 20 && buf.readUInt32LE(0) === 0x46546c67;

    let json: GltfJson;
    if (isGlb) {
      const jsonLen = buf.readUInt32LE(12);
      json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    } else {
      json = JSON.parse(buf.toString('utf8'));
    }
    const hasExternal = [...(json.images ?? []), ...(json.buffers ?? [])].some((e) => e.uri && !e.uri.startsWith('data:'));
    if (hasExternal) {
      const missing = await inlineExternal(json, dir);
      if (missing.length) notes.push(`Referenced file(s) not found next to the model, shown untextured: ${missing.join(', ')}`);
      buf = isGlb ? rewriteGlb(buf, json) : Buffer.from(JSON.stringify(json), 'utf8');
    }
    return { kind: 'gltf', bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), notes };
  },
};
