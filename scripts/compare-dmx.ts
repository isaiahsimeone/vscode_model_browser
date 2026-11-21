// Dev check: a binary DMX and its keyvalues2 conversion (by Valve's dmxconvert) must give the same element graph.
//   node out/compare-dmx.js a_binary.dmx a_text.dmx
import { readFileSync } from 'node:fs';
import { parseDmx } from '../src/loaders/dmx';
import { DmElement, type Datamodel } from '../src/loaders/dmx/datamodel';

export function compareDatamodels(a: Datamodel, b: Datamodel): string[] {
  const diffs: string[] = [];
  const byIdB = new Map(b.elements.map((e) => [e.id, e]));
  const norm = (v: unknown): unknown => {
    if (v instanceof DmElement) return `@${v.id}`;
    if (v === null) return null;
    if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>, (x) => (typeof x === 'bigint' ? Number(x) : x));
    if (Array.isArray(v)) return v.map(norm);
    return v;
  };
  const same = (x: unknown, y: unknown): boolean => {
    if (typeof x === 'number' && typeof y === 'number') return Math.abs(x - y) <= 1e-4 * Math.max(1, Math.abs(x));
    if (Array.isArray(x) && Array.isArray(y)) return x.length === y.length && x.every((v, i) => same(v, y[i]));
    return x === y;
  };
  if (a.elements.length !== b.elements.length) diffs.push(`element count ${a.elements.length} vs ${b.elements.length}`);
  for (const ea of a.elements) {
    const eb = byIdB.get(ea.id);
    if (!eb) { diffs.push(`missing ${ea.type} ${ea.id}`); continue; }
    if (ea.type !== eb.type || ea.name !== eb.name) diffs.push(`${ea.id}: ${ea.type}/${ea.name} vs ${eb.type}/${eb.name}`);
    for (const [k, va] of ea.attrs) {
      if (k === 'name' && va === '' && !eb.attrs.has(k)) continue; // dmxconvert omits empty names
      if (!eb.attrs.has(k)) { diffs.push(`${ea.type}.${k} missing in text`); continue; }
      if (!same(norm(va), norm(eb.attrs.get(k)))) diffs.push(`${ea.type}.${k}: ${JSON.stringify(norm(va)).slice(0, 80)} vs ${JSON.stringify(norm(eb.attrs.get(k))).slice(0, 80)}`);
    }
    for (const k of eb.attrs.keys()) if (!ea.attrs.has(k)) diffs.push(`${eb.type}.${k} missing in binary`);
  }
  return diffs;
}

if (require.main === module) {
  const [binPath, txtPath] = process.argv.slice(2);
  const a = parseDmx(new Uint8Array(readFileSync(binPath)));
  const b = parseDmx(new Uint8Array(readFileSync(txtPath)));
  const d = compareDatamodels(a, b);
  console.log(`${a.elements.length} elements; ${d.length} differences`);
  for (const x of d.slice(0, process.env.ALL ? 1e9 : 30)) console.log('  ' + x);
  process.exit(d.length ? 1 : 0);
}
