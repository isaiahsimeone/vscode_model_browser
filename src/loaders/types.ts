// The loader contract. Loaders run in the extension host (Node), never in the webview, and they never import
// `vscode`, so the test suite and the sweep script can run them headlessly.

export interface LoaderSettings {
  /** Path to the Source2Viewer-CLI executable (for .vmdl_c). */
  s2vPath?: string;
  /** Path to a gameinfo.gi, so s2v can resolve materials/textures from the game's VPKs. */
  gameInfo?: string;
  /** Extra folders that Source 2 content paths ("models/foo.dmx") are resolved against. */
  contentRoots: string[];
}

export interface LoadContext {
  settings: LoaderSettings;
  /** A writable folder for converted files (e.g. s2v output). */
  cacheDir: string;
  log(message: string): void;
  /** Loaders that hand off to another format (vmdl → dmx, vmdl_c → glb) call back into the registry with this. */
  loadAs(path: string, loaderId?: string): Promise<ModelData>;
  signal?: AbortSignal;
}

export interface ModelLoader {
  id: string;
  /** Lowercase, with the dot: [".dmx"]. Compound extensions (".vmdl_c") are matched on the full suffix. */
  extensions: string[];
  /** Human-readable name for the editor registration and the README table. */
  label: string;
  load(path: string, ctx: LoadContext): Promise<ModelData>;
}

export interface MaterialGroup {
  /** First index (into `indices`) of this group. */
  start: number;
  /** Number of indices. */
  count: number;
  material: string;
}

export interface MeshPart {
  name: string;
  positions: Float32Array; // xyz
  normals?: Float32Array; // xyz
  uvs?: Float32Array; // uv
  indices: Uint32Array; // triangles
  groups: MaterialGroup[];
  /** Starts hidden in the viewer (higher LODs, non-default body groups); toggled in the Parts list. */
  hidden?: boolean;
}

export interface Bone {
  name: string;
  parent: number; // -1 for roots
  /** World-space bind position. */
  position: [number, number, number];
}

export interface Notes {
  /** Things the user should know: missing parts, unsupported bits, which tool converted the file. */
  notes?: string[];
}

export type ModelData =
  | ({ kind: 'gltf'; bytes: Uint8Array; upAxis?: 'Y' | 'Z' } & Notes)
  | ({ kind: 'obj'; text: string; mtl?: string } & Notes)
  | ({ kind: 'ply'; bytes: Uint8Array; pointCloud: boolean } & Notes)
  | ({ kind: 'mesh'; meshes: MeshPart[]; skeleton?: Bone[]; upAxis: 'Y' | 'Z' } & Notes);
