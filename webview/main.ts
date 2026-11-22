import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { FromWebview, ToWebview } from '../src/editor/ModelEditorProvider';
import type { ModelData, MeshPart, Bone } from '../src/loaders/types';

// ---------------------------------------------------------------------------------------------------------------
// Host bridge (VS Code, or the dev preview harness which provides the same shape)

interface Persisted {
  wireframe: boolean;
  skeleton: boolean;
  grid: boolean;
  panel: boolean;
  bg: 'theme' | 'dark' | 'light';
}
declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };
const host =
  typeof acquireVsCodeApi === 'function'
    ? acquireVsCodeApi()
    : ((window as unknown as { __host: ReturnType<typeof acquireVsCodeApi> }).__host ?? {
        postMessage: () => {},
        getState: () => undefined,
        setState: () => {},
      });
const send = (m: FromWebview) => host.postMessage(m);
const state: Persisted = { wireframe: false, skeleton: true, grid: true, panel: true, bg: 'theme', ...(host.getState() as Partial<Persisted>) };
const save = () => host.setState(state);

// ---------------------------------------------------------------------------------------------------------------
// DOM

const app = document.getElementById('app')!;
app.innerHTML = `
  <div id="toolbar">
    <div id="title"><span id="name"></span><span id="kind"></span></div>
    <div id="buttons">
      <button data-act="frame" title="Frame model (F)">Frame</button>
      <button data-act="wireframe" title="Wireframe (W)">Wire</button>
      <button data-act="skeleton" title="Skeleton (B)">Bones</button>
      <button data-act="grid" title="Grid (G)">Grid</button>
      <button data-act="up" title="Swap up axis (U)">Z-up</button>
      <button data-act="bg" title="Background (K)">Bg</button>
      <button data-act="panel" title="Side panel (P)">Panel</button>
      <button data-act="text" title="Reopen with the text editor">Text</button>
    </div>
  </div>
  <div id="main">
    <div id="viewport"><div id="overlay" class="hidden"></div><div id="hud"></div></div>
    <aside id="panel">
      <section id="stats"></section>
      <section id="notes-sec" hidden><h3>Notes</h3><ul id="notes"></ul></section>
      <section id="anim-sec" hidden><h3>Animations</h3><div id="anims"></div></section>
      <section id="parts-sec" hidden><h3>Parts <span class="count" id="parts-count"></span></h3><div id="parts"></div></section>
      <section id="mats-sec" hidden><h3>Materials <span class="count" id="mats-count"></span></h3><div id="mats"></div></section>
    </aside>
  </div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewport = $('viewport');
const overlay = $('overlay');
const hud = $('hud');

// ---------------------------------------------------------------------------------------------------------------
// Three.js scene

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
viewport.prepend(renderer.domElement);

const scene = new THREE.Scene();
function buildEnvironment() {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment?.dispose();
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}
buildEnvironment();
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
camera.position.set(2, 1.5, 3);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 2, 1.5);
camera.add(sun);
scene.add(camera);

/** Holds the up-axis rotation; everything model-related lives under it. */
const modelRoot = new THREE.Group();
scene.add(modelRoot);
let grid: THREE.GridHelper | undefined;
let skeletonObj: THREE.Object3D | undefined;
let mixer: THREE.AnimationMixer | undefined;
let upAxis: 'Y' | 'Z' = 'Y';
const clock = new THREE.Timer();
let dirty = true;
const invalidate = () => (dirty = true);
controls.addEventListener('change', invalidate);
// Webviews (and headless browsers) can lose the GL context; three re-uploads buffers itself, but the
// environment map is a render target and must be rebuilt, and we only draw when something changed.
renderer.domElement.addEventListener('webglcontextlost', (e) => e.preventDefault());
renderer.domElement.addEventListener('webglcontextrestored', () => {
  buildEnvironment();
  invalidate();
});

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  invalidate();
}
new ResizeObserver(resize).observe(viewport);

function loop() {
  requestAnimationFrame(loop);
  clock.update();
  const dt = clock.getDelta();
  if (controls.update()) dirty = true;
  if (mixer && currentAction && !currentAction.paused) {
    mixer.update(dt);
    dirty = true;
  }
  if (dirty) {
    dirty = false;
    renderer.render(scene, camera);
  }
}
loop();

function applyBackground() {
  const css = getComputedStyle(document.body);
  const theme = css.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
  const color = state.bg === 'dark' ? '#202124' : state.bg === 'light' ? '#d9dce1' : theme;
  scene.background = new THREE.Color(color);
  invalidate();
}
new MutationObserver(applyBackground).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

// ---------------------------------------------------------------------------------------------------------------
// Building scenes from ModelData

/** Stable, distinct-ish colour per material name. */
function materialColor(name: string): THREE.Color {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  const hue = ((h >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.42, 0.62, THREE.SRGBColorSpace);
}

function buildMeshParts(parts: MeshPart[]): THREE.Group {
  const group = new THREE.Group();
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  const matFor = (name: string) => {
    let m = mats.get(name);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color: materialColor(name), roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide, name });
      mats.set(name, m);
    }
    return m;
  };
  for (const p of parts) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
    if (p.normals) g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
    if (p.uvs) g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(p.indices, 1));
    if (!p.normals) g.computeVertexNormals();
    const groupMats: THREE.Material[] = [];
    for (const grp of p.groups) {
      g.addGroup(grp.start, grp.count, groupMats.length);
      groupMats.push(matFor(grp.material));
    }
    const mesh = new THREE.Mesh(g, groupMats.length ? groupMats : matFor('default'));
    mesh.name = p.name;
    mesh.visible = !p.hidden;
    group.add(mesh);
  }
  return group;
}

function buildBones(bones: Bone[]): THREE.Object3D {
  const pts: number[] = [];
  for (const b of bones) {
    if (b.parent < 0) continue;
    const p = bones[b.parent].position;
    pts.push(p[0], p[1], p[2], ...b.position);
  }
  const obj = new THREE.Group();
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x4fc3f7, depthTest: false, transparent: true }));
  const dotGeo = new THREE.BufferGeometry();
  dotGeo.setAttribute('position', new THREE.Float32BufferAttribute(bones.flatMap((b) => b.position), 3));
  const dots = new THREE.Points(dotGeo, new THREE.PointsMaterial({ color: 0xffd54f, size: 5, sizeAttenuation: false, depthTest: false, transparent: true }));
  lines.renderOrder = dots.renderOrder = 10;
  obj.add(lines, dots);
  return obj;
}

/** GLTFLoader sanitises node names (drops "/" and "."), but keeps the original in userData.name. Source 2 Viewer
 *  names meshes "<full path>.vmdl_c.<mesh>"; show just the mesh part. */
function displayName(o: THREE.Object3D): string {
  const raw: string = o.userData?.name ?? o.name ?? '';
  const m = /\.vmdl_c\.(.+)$/i.exec(raw);
  return m ? m[1] : raw.split(/[\\/]/).pop() ?? raw;
}

async function buildGltf(bytes: Uint8Array): Promise<{ root: THREE.Object3D; clips: THREE.AnimationClip[] }> {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  gltf.scene.traverse((o) => {
    o.name = displayName(o);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Plain white with no texture (e.g. a material s2v could not find) shows no shape; colour it per mesh instead.
    const fix = (m: THREE.Material) => {
      const std = m as THREE.MeshStandardMaterial;
      if (std.isMeshStandardMaterial && !std.map && std.color.equals(new THREE.Color(1, 1, 1))) {
        // Materials are often shared between meshes; clone so each part gets its own colour.
        const c = std.clone();
        c.color = materialColor(o.name);
        c.roughness = Math.max(c.roughness, 0.7);
        c.metalness = Math.min(c.metalness, 0.1);
        c.name = std.name || o.name;
        return c;
      }
      return m;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fix) : fix(mesh.material);
  });
  return { root: gltf.scene, clips: gltf.animations };
}

function buildPly(bytes: Uint8Array, pointCloud: boolean, name: string): THREE.Object3D {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const geometry = new PLYLoader().parse(buf);
  const vertexColors = geometry.hasAttribute('color');
  const color = vertexColors ? new THREE.Color(1, 1, 1) : materialColor(name);
  const matName = vertexColors ? 'vertex colours' : 'ply';
  if (pointCloud || !geometry.index) {
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors, color, name: matName }));
    points.name = name;
    return points;
  }
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors, color, roughness: 0.75, metalness: 0.05, side: THREE.DoubleSide, name: matName }),
  );
  mesh.name = name;
  return mesh;
}

function buildObj(text: string, mtl?: string): THREE.Object3D {
  const loader = new OBJLoader();
  if (mtl) {
    const creator = new MTLLoader().parse(mtl, '');
    creator.preload();
    loader.setMaterials(creator);
  }
  const root = loader.parse(text);
  // OBJ files without materials come in a flat grey; give each material group its own colour instead.
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const recolor = (m: THREE.Material) => {
      if (mtl) return m;
      const name = m.name || o.name || 'default';
      return new THREE.MeshStandardMaterial({ color: materialColor(name), roughness: 0.75, side: THREE.DoubleSide, name });
    };
    o.material = Array.isArray(o.material) ? o.material.map(recolor) : recolor(o.material);
  });
  return root;
}

// ---------------------------------------------------------------------------------------------------------------
// Loading + panel

let content: THREE.Object3D | undefined;
let clips: THREE.AnimationClip[] = [];
let currentAction: THREE.AnimationAction | undefined;

function disposeContent() {
  if (!content) return;
  content.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
  modelRoot.clear();
  content = skeletonObj = undefined;
  mixer?.stopAllAction();
  mixer = currentAction = undefined;
  clips = [];
}

function setUp(axis: 'Y' | 'Z') {
  upAxis = axis;
  modelRoot.rotation.set(axis === 'Z' ? -Math.PI / 2 : 0, 0, 0);
  modelRoot.updateMatrixWorld(true);
  btn('up').textContent = axis === 'Z' ? 'Z-up' : 'Y-up';
  placeGrid();
}

function bounds(): THREE.Box3 {
  const box = new THREE.Box3();
  modelRoot.updateMatrixWorld(true);
  if (content) {
    content.traverse((o) => {
      if (((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) && o.visible) box.expandByObject(o);
    });
  }
  if (box.isEmpty() && skeletonObj) box.expandByObject(skeletonObj);
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  return box;
}

function placeGrid() {
  if (grid) {
    scene.remove(grid);
    grid.geometry.dispose();
    (grid.material as THREE.Material).dispose();
  }
  const box = bounds();
  const size = box.getSize(new THREE.Vector3());
  const extent = Math.max(size.x, size.z, size.y * 0.5, 1e-3);
  const step = 10 ** Math.floor(Math.log10(extent / 2));
  const cells = Math.ceil((extent * 2) / step / 2) * 2;
  grid = new THREE.GridHelper(cells * step, cells, 0x888888, 0x555555);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  const c = box.getCenter(new THREE.Vector3());
  grid.position.set(Math.round(c.x / step) * step, box.min.y, Math.round(c.z / step) * step);
  grid.visible = state.grid;
  scene.add(grid);
  hud.dataset.step = `grid ${fmt(step)} units`;
  updateHud();
  invalidate();
}

function frame() {
  const box = bounds();
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 1e-3);
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.1;
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0.6, 0.45, 0.8).normalize();
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(dir, dist);
  camera.near = dist / 1000;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  controls.update();
  invalidate();
}

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 1 ? n.toFixed(1) : n.toPrecision(2));

function updateHud() {
  hud.textContent = [hud.dataset.size, hud.dataset.step].filter(Boolean).join(' · ');
}

function fillPanel(data: ModelData, loader: string, ms: number) {
  let verts = 0, tris = 0, meshes = 0, bones = 0;
  const mats = new Map<string, THREE.Color | null>();
  content?.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((o as THREE.Points).isPoints) {
      verts += m.geometry.getAttribute('position')?.count ?? 0;
      const mat = m.material as THREE.PointsMaterial;
      mats.set(mat.name || '(unnamed)', mat.vertexColors ? null : mat.color);
    }
    if (m.isMesh) {
      meshes++;
      const pos = m.geometry.getAttribute('position');
      verts += pos?.count ?? 0;
      tris += (m.geometry.index ? m.geometry.index.count : pos?.count ?? 0) / 3;
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        const c = (mat as THREE.MeshStandardMaterial).color;
        mats.set(mat.name || '(unnamed)', (mat as THREE.MeshStandardMaterial).map || mat.vertexColors ? null : c ?? null);
      }
    }
    if ((o as THREE.Bone).isBone) bones++;
  });
  if (data.kind === 'mesh' && data.skeleton) bones = data.skeleton.length;
  const size = bounds().getSize(new THREE.Vector3());
  hud.dataset.size = `${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}`;
  updateHud();

  $('stats').innerHTML = `
    <div class="grid">
      <span>Vertices</span><b>${verts.toLocaleString()}</b>
      <span>Triangles</span><b>${Math.round(tris).toLocaleString()}</b>
      <span>Meshes</span><b>${meshes}</b>
      <span>Materials</span><b>${mats.size}</b>
      <span>Bones</span><b>${bones}</b>
      <span>Size</span><b>${fmt(size.x)} × ${fmt(size.y)} × ${fmt(size.z)}</b>
      <span>Loaded in</span><b>${ms} ms</b>
    </div>`;
  $('kind').textContent = loader;

  const notes = data.notes ?? [];
  $('notes').innerHTML = notes.map((n) => `<li>${esc(n)}</li>`).join('');
  $('notes-sec').hidden = !notes.length;

  // Parts: toggle visibility per mesh.
  const partsEl = $('parts');
  partsEl.innerHTML = '';
  const meshList: THREE.Mesh[] = [];
  content?.traverse((o) => (o as THREE.Mesh).isMesh && meshList.push(o as THREE.Mesh));
  $('parts-count').textContent = `${meshList.length}`;
  $('parts-sec').hidden = meshList.length < 2;
  meshList.forEach((m, i) => {
    const row = document.createElement('label');
    row.className = 'row';
    row.innerHTML = `<input type="checkbox" ${m.visible ? 'checked' : ''}><span>${esc(m.name || `mesh ${i}`)}</span>`;
    const box = row.querySelector('input')!;
    box.addEventListener('change', () => {
      m.visible = box.checked;
      invalidate();
    });
    partsEl.append(row);
  });

  $('mats').innerHTML = [...mats]
    .map(([name, c]) => `<div class="row" title="${esc(name)}"><i class="swatch${c ? '' : ' tex'}" style="${c ? `background:#${c.getHexString()}` : ''}"></i><span>${esc(name)}</span></div>`)
    .join('');
  $('mats-count').textContent = `${mats.size}`;
  $('mats-sec').hidden = !mats.size;

  const animEl = $('anims');
  animEl.innerHTML = '';
  $('anim-sec').hidden = !clips.length;
  if (clips.length && content) {
    mixer = new THREE.AnimationMixer(content);
    const select = document.createElement('select');
    select.innerHTML = `<option value="-1">(bind pose)</option>` + clips.map((c, i) => `<option value="${i}">${esc(c.name || `clip ${i}`)} (${c.duration.toFixed(1)}s)</option>`).join('');
    const play = document.createElement('button');
    play.textContent = 'Pause';
    play.disabled = true;
    select.addEventListener('change', () => {
      mixer!.stopAllAction();
      currentAction = undefined;
      const i = +select.value;
      if (i >= 0) {
        currentAction = mixer!.clipAction(clips[i]);
        currentAction.play();
        play.textContent = 'Pause';
      }
      play.disabled = !currentAction;
      invalidate();
    });
    play.addEventListener('click', () => {
      if (!currentAction) return;
      currentAction.paused = !currentAction.paused;
      play.textContent = currentAction.paused ? 'Play' : 'Pause';
    });
    animEl.append(select, play);
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function showOverlay(html: string) {
  overlay.innerHTML = html;
  overlay.classList.remove('hidden');
}
const hideOverlay = () => overlay.classList.add('hidden');

let firstModel = true;
async function showModel(msg: Extract<ToWebview, { type: 'model' }>) {
  const { data } = msg;
  disposeContent();
  try {
    if (data.kind === 'mesh') {
      content = buildMeshParts(data.meshes);
      if (data.skeleton?.length) skeletonObj = buildBones(data.skeleton);
    } else if (data.kind === 'gltf') {
      const g = await buildGltf(data.bytes);
      content = g.root;
      clips = g.clips;
      let hasBones = false;
      content.traverse((o) => ((o as THREE.Bone).isBone ? (hasBones = true) : 0));
      if (hasBones) {
        const helper = new THREE.SkeletonHelper(content);
        (helper.material as THREE.LineBasicMaterial).depthTest = false;
        helper.renderOrder = 10;
        skeletonObj = helper;
      }
    } else if (data.kind === 'ply') {
      content = buildPly(data.bytes, data.pointCloud, msg.file.replace(/\.ply$/i, ''));
    } else {
      content = buildObj(data.text, data.mtl);
    }
  } catch (e) {
    showOverlay(`<div class="err"><h2>Could not display ${esc(msg.file)}</h2><pre>${esc(String((e as Error).message ?? e))}</pre></div>`);
    return;
  }
  modelRoot.add(content);
  if (skeletonObj) {
    // SkeletonHelper reads world matrices itself, so it must not inherit the up-axis rotation twice.
    if (skeletonObj instanceof THREE.SkeletonHelper) scene.add(skeletonObj);
    else modelRoot.add(skeletonObj);
    skeletonObj.visible = state.skeleton;
  }
  applyWireframe();
  $('name').textContent = msg.file;
  document.title = msg.file;
  setUp(msg.upAxis ?? (data.kind === 'mesh' ? data.upAxis : data.kind === 'gltf' ? data.upAxis ?? 'Y' : 'Y'));
  fillPanel(data, msg.loader, msg.ms);
  // Keep the camera when the same file reloads (e.g. rebuilt on disk); frame on first show.
  if (firstModel) frame();
  firstModel = false;
  hideOverlay();
  invalidate();
}

function applyWireframe() {
  content?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) (mat as THREE.MeshStandardMaterial).wireframe = state.wireframe;
  });
  invalidate();
}

// ---------------------------------------------------------------------------------------------------------------
// Toolbar + keys

const btn = (act: string) => document.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
function syncButtons() {
  btn('wireframe').classList.toggle('on', state.wireframe);
  btn('skeleton').classList.toggle('on', state.skeleton);
  btn('grid').classList.toggle('on', state.grid);
  btn('panel').classList.toggle('on', state.panel);
  btn('bg').textContent = state.bg === 'theme' ? 'Bg: theme' : state.bg === 'dark' ? 'Bg: dark' : 'Bg: light';
  $('panel').classList.toggle('hidden', !state.panel);
  save();
}

const actions: Record<string, () => void> = {
  frame,
  wireframe: () => {
    state.wireframe = !state.wireframe;
    applyWireframe();
  },
  skeleton: () => {
    state.skeleton = !state.skeleton;
    if (skeletonObj) skeletonObj.visible = state.skeleton;
    invalidate();
  },
  grid: () => {
    state.grid = !state.grid;
    if (grid) grid.visible = state.grid;
    invalidate();
  },
  up: () => {
    setUp(upAxis === 'Z' ? 'Y' : 'Z');
    send({ type: 'setUpAxis', axis: upAxis });
    frame();
  },
  bg: () => {
    state.bg = state.bg === 'theme' ? 'dark' : state.bg === 'dark' ? 'light' : 'theme';
    applyBackground();
  },
  panel: () => {
    state.panel = !state.panel;
    requestAnimationFrame(resize);
  },
  text: () => send({ type: 'openAsText' }),
};
document.getElementById('buttons')!.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest('button')?.dataset.act;
  if (act && actions[act]) {
    actions[act]();
    syncButtons();
  }
});
const keys: Record<string, string> = { f: 'frame', w: 'wireframe', b: 'skeleton', g: 'grid', u: 'up', k: 'bg', p: 'panel' };
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest('input,select')) return;
  const act = keys[e.key.toLowerCase()];
  if (act) {
    actions[act]();
    syncButtons();
  }
});
renderer.domElement.addEventListener('dblclick', frame);

overlay.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest('button')?.dataset.msg as FromWebview['type'] | undefined;
  if (act) send({ type: act } as FromWebview);
});

// ---------------------------------------------------------------------------------------------------------------
// Messages

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case 'loading':
      $('name').textContent = m.file;
      if (!content) showOverlay(`<div class="spin"></div><p>Loading ${esc(m.file)}…</p>`);
      break;
    case 'model':
      void showModel(m);
      break;
    case 'error':
      showOverlay(
        `<div class="err"><h2>Could not open ${esc(m.file)}</h2><pre>${esc(m.message)}</pre>
         <div class="actions">
           ${m.action === 'configureS2V' ? `<button data-msg="configureS2V">Set Source2Viewer-CLI path…</button>` : ''}
           <button data-msg="reload">Retry</button>
           <button data-msg="openAsText">Open as text</button>
         </div></div>`,
      );
      break;
  }
});

applyBackground();
syncButtons();
resize();
send({ type: 'ready' });
