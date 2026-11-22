# Model Browser

View 3D models inside VS Code. Open a model file and it shows up in a 3D viewer tab. The **Models** sidebar lists every model in the workspace, so you can click through them.

Built for Source 2 modding, where the usual VS Code model viewers stop at glTF and OBJ.

## Install

1. Download `model-browser-<version>.vsix` from the [latest release](https://github.com/isaiahsimeone/vscode_model_browser/releases/latest).
2. In VS Code, open the Extensions view, click **…** → **Install from VSIX…**, and pick the file.
   Or from a terminal: `code --install-extension model-browser-<version>.vsix`
3. To view compiled `.vmdl_c` models, also set `modelBrowser.s2vPath` (see [Settings](#settings)).

| Format | Extension | How it's read | Opens by default |
|---|---|---|---|
| glTF | `.glb`, `.gltf` | three.js. External textures and buffers next to the file are inlined | `.glb` yes, `.gltf` via *Open in Model Browser* |
| Wavefront OBJ | `.obj` (+ `.mtl`) | three.js | via *Open in Model Browser* |
| Valve DMX | `.dmx` | Built-in reader for **binary (v1–9)** and **keyvalues2** encodings: meshes, materials, skeleton | yes |
| Source 2 model source | `.vmdl` | KV3 parser; loads every `RenderMeshFile` (`.dmx`) and merges them. Higher LODs and non-default body groups start hidden | via *Open in Model Browser* |
| Source 2 compiled model | `.vmdl_c` | Converted to glTF by [Source 2 Viewer CLI](https://github.com/ValveResourceFormat/ValveResourceFormat) (textures, skeleton, animations), cached | yes |

Text formats (`.gltf`, `.obj`, `.vmdl`) keep the text editor as their default. Use the eye button in the editor title, *Open in Model Browser* in the explorer's right-click menu, or *Reopen Editor With…*.

## The viewer

- Orbit with left-drag, pan with right-drag or shift-drag, and zoom with the wheel. Double-click to frame the model.
- Toolbar and keys: **F** frame, **W** wireframe, **B** bones, **G** grid, **U** swap Z-up / Y-up, **K** background, **P** side panel. **Text** reopens the file as text.
- The side panel shows vertex, triangle, mesh, material and bone counts and the model's size. You can toggle parts on and off, see the material list, and play any animations the file contains. Notes explain anything that couldn't be loaded.
- `.dmx` and `.vmdl` don't carry textures, so each material gets its own stable colour.
- The viewer reloads when the file changes on disk.

## Settings

| Setting | What it's for |
|---|---|
| `modelBrowser.s2vPath` | Path to `Source2Viewer-CLI`, needed for `.vmdl_c`. Download it from the [ValveResourceFormat releases](https://github.com/ValveResourceFormat/ValveResourceFormat/releases). |
| `modelBrowser.gameInfo` | Optional `gameinfo.gi` (e.g. `…/Deadlock/game/citadel/gameinfo.gi`), so s2v can find materials and textures in the game's VPKs. |
| `modelBrowser.contentRoots` | Extra folders that `.vmdl` mesh paths (`models/…/x.dmx`) are resolved against. Folders above the `.vmdl` are always tried first. |
| `modelBrowser.exclude` | Globs left out of the Models sidebar. |

## Adding a format

Each format is a **loader**: a small module that turns a file into a `ModelData`. Loaders run in the extension host (Node) and don't import `vscode`, so tests and scripts can run them headlessly.

```ts
// src/loaders/myformat.ts
import type { ModelLoader } from './types';

export const myLoader: ModelLoader = {
  id: 'myformat',
  label: 'My Format',
  extensions: ['.mine'],
  async load(file, ctx) {
    // Return one of:
    //   { kind: 'mesh', meshes: MeshPart[], skeleton?, upAxis }   positions/normals/uvs/indices + material groups
    //   { kind: 'gltf', bytes }                                     anything you can convert to glTF
    //   { kind: 'obj',  text, mtl? }
    // ctx.loadAs(otherFile) loads another file through the registry (that's how .vmdl reuses the .dmx loader).
  },
};
```

Then:
1. Add it to the `loaders` list in `src/loaders/registry.ts`.
2. Add `*.mine` to a `customEditors` selector in `package.json`. `npm run check-manifest` verifies the two agree.

Nothing changes on the webview side unless you need a new `kind`.

## Development

```sh
npm install
npm run build          # dist/extension.js + dist/webview.js
npm run watch
npm test               # loader tests on synthetic fixtures (no game assets in the repo)
npm run typecheck
npm run sweep -- <folder> [--s2v <path>] [--game <gameinfo.gi>] [--verbose]
                       # loads every model under a folder headlessly and reports failures
npm run preview -- [--s2v <path>]
                       # serves the real webview at http://localhost:5178/?file=<abs path>, no VS Code needed
npm run package        # builds model-browser-<version>.vsix
```

Install a build with `code --install-extension model-browser-0.1.0.vsix`, or press F5 in VS Code to launch an Extension Development Host.

### Releasing

1. Bump `version` in `package.json` (and add a `CHANGELOG.md` entry), then commit.
2. Tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.
3. The **Release** workflow builds, tests and publishes a GitHub Release with the `.vsix` attached. It fails if the tag doesn't match `package.json`.

### Layout

```
src/extension.ts                    activation: editors, sidebar, commands
src/editor/ModelEditorProvider.ts   custom editor: runs a loader, posts the result to the webview
src/browser/ModelTree.ts            Models sidebar
src/loaders/                        one module per format + registry + shared types
  dmx/binary.ts, dmx/kv2.ts         DMX readers → dmx/datamodel.ts (element graph) → dmx/toMesh.ts
  kv3.ts                            KeyValues3 text parser (.vmdl)
webview/main.ts                     three.js viewer UI
scripts/                            sweep, preview harness, manifest check, DMX compare
```

## License

MIT. Source 2 Viewer CLI is a separate download under its own license.
