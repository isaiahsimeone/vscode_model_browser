import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { ModelLoader } from './types';

export const objLoader: ModelLoader = {
  id: 'obj',
  label: 'Wavefront OBJ',
  extensions: ['.obj'],
  async load(file) {
    const text = await readFile(file, 'utf8');
    const lib = /^mtllib\s+(.+)$/m.exec(text)?.[1]?.trim();
    let mtl: string | undefined;
    const notes: string[] = [];
    if (lib) {
      try {
        mtl = await readFile(path.join(path.dirname(file), lib), 'utf8');
      } catch {
        notes.push(`Material library ${lib} not found; using default colours.`);
      }
    }
    return { kind: 'obj', text, mtl, notes };
  },
};
