import * as path from 'node:path';
import { gltfLoader } from './gltf';
import { objLoader } from './obj';
import { dmxLoader } from './dmx';
import { vmdlLoader } from './vmdl';
import { vmdlcLoader } from './vmdlc';
import { stlLoader } from './stl';
import type { LoadContext, ModelData, ModelLoader } from './types';

/** Every format the extension understands. To add one: write a ModelLoader, add it here, and add its
 *  extensions to package.json (`npm run check-manifest` verifies the two agree). */
export const loaders: ModelLoader[] = [gltfLoader, objLoader, dmxLoader, vmdlLoader, vmdlcLoader, stlLoader];

export const allExtensions = (): string[] => loaders.flatMap((l) => l.extensions);

/** Longest matching suffix wins, so ".vmdl_c" is not mistaken for anything shorter. */
export function loaderFor(file: string): ModelLoader | undefined {
  const name = path.basename(file).toLowerCase();
  let best: ModelLoader | undefined;
  let bestLen = 0;
  for (const l of loaders) {
    for (const ext of l.extensions) {
      if (name.endsWith(ext) && ext.length > bestLen) {
        best = l;
        bestLen = ext.length;
      }
    }
  }
  return best;
}

export async function loadModel(file: string, ctx: Omit<LoadContext, 'loadAs'>, loaderId?: string): Promise<ModelData> {
  const loader = loaderId ? loaders.find((l) => l.id === loaderId) : loaderFor(file);
  if (!loader) throw new Error(`No loader for ${path.basename(file)}`);
  const full: LoadContext = { ...ctx, loadAs: (p, id) => loadModel(p, ctx, id) };
  return loader.load(file, full);
}
