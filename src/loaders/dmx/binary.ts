// Reader for DMX "binary" encoding, versions 1-9 (Source 1 uses 2-5, Source 2 uses 9).
//
// Layout (all little-endian):
//   header line "<!-- dmx encoding binary N format F V -->\n" + NUL
//   v9+: int32 prefix-element count, then each prefix element's attributes (same shape as element bodies)
//   v2+: string table — count (int16 before v4, int32 after), then NUL-terminated strings
//   int32 element count, then per element: type, name (string-table refs from v4; inline before), 16-byte GUID
//   per element: int32 attribute count, then per attribute: name ref, uint8 type, value
// Attribute type ids: 1..14 element…matrix, (v9: 15 uint64, 16 uint8); arrays are base+14 before v9, base+32 from v9.

import { ATTR_TYPES, COMPONENTS, DmElement, type AttrType, type AttrValue, type Datamodel, type DmxHeader } from './datamodel';

class Reader {
  pos = 0;
  private dv: DataView;
  private dec = new TextDecoder('utf-8');
  constructor(public buf: Uint8Array) {
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  need(n: number) {
    if (this.pos + n > this.buf.length) throw new Error(`Unexpected end of file at offset ${this.pos}`);
  }
  u8() {
    this.need(1);
    return this.buf[this.pos++];
  }
  i16() {
    this.need(2);
    const v = this.dv.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }
  cstr() {
    const end = this.buf.indexOf(0, this.pos);
    if (end < 0) throw new Error(`Unterminated string at offset ${this.pos}`);
    const s = this.dec.decode(this.buf.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }
  bytes(n: number) {
    this.need(n);
    const b = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  floats(count: number): Float32Array {
    this.need(count * 4);
    const out = new Float32Array(count);
    if ((this.buf.byteOffset + this.pos) % 4 === 0) {
      out.set(new Float32Array(this.buf.buffer, this.buf.byteOffset + this.pos, count));
    } else {
      for (let i = 0; i < count; i++) out[i] = this.dv.getFloat32(this.pos + i * 4, true);
    }
    this.pos += count * 4;
    return out;
  }
  ints(count: number): Int32Array {
    this.need(count * 4);
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) out[i] = this.dv.getInt32(this.pos + i * 4, true);
    this.pos += count * 4;
    return out;
  }
}

function guidString(b: Uint8Array): string {
  // Valve writes the GUID as raw bytes; render it the way keyvalues2 would (little-endian first three groups).
  const h = (i: number) => b[i].toString(16).padStart(2, '0');
  return (
    h(3) + h(2) + h(1) + h(0) + '-' + h(5) + h(4) + '-' + h(7) + h(6) + '-' + h(8) + h(9) + '-' +
    h(10) + h(11) + h(12) + h(13) + h(14) + h(15)
  );
}

interface Ref {
  el: DmElement;
  attr: string;
  index: number; // -1 = single
  target: number; // element index
}

export function readBinary(buf: Uint8Array, header: DmxHeader): Datamodel {
  const r = new Reader(buf);
  const v = header.encodingVersion;
  if (v < 1 || v > 9) throw new Error(`Unsupported binary DMX version ${v}`);
  r.pos = header.length;
  // The header line is followed by a NUL.
  if (buf[r.pos] === 0) r.pos++;

  let strings: string[] = [];
  const strRef = () => {
    const i = v >= 5 ? r.i32() : r.i16();
    if (i < 0) return '';
    const s = strings[i];
    if (s === undefined) throw new Error(`String index ${i} out of range at offset ${r.pos}`);
    return s;
  };
  const nameRef = () => (v >= 2 ? strRef() : r.cstr());

  const arrayBase = v >= 9 ? 32 : 14;
  const refs: Ref[] = [];

  const readValue = (el: DmElement, attr: string, typeId: number): AttrValue => {
    if (typeId > arrayBase) return readArray(el, attr, typeId - arrayBase);
    const type = ATTR_TYPES[typeId - 1] as AttrType | undefined;
    switch (type) {
      case 'element': {
        const idx = r.i32();
        if (idx === -2) {
          r.cstr(); // reference to an element in another file, by GUID; not resolvable here
          return null;
        }
        if (idx >= 0) refs.push({ el, attr, index: -1, target: idx });
        return null;
      }
      case 'int':
        return r.i32();
      case 'float':
        return r.f32();
      case 'bool':
        return r.u8() !== 0;
      case 'string':
        return v >= 4 ? strRef() : r.cstr();
      case 'binary':
        return r.bytes(r.i32());
      case 'time':
        return r.i32() / 10000;
      case 'color':
        return [r.u8(), r.u8(), r.u8(), r.u8()];
      case 'uint64': {
        const lo = r.i32() >>> 0;
        const hi = r.i32() >>> 0;
        return hi * 2 ** 32 + lo;
      }
      case 'uint8':
        return r.u8();
      case undefined:
        throw new Error(`Unknown attribute type ${typeId} for "${attr}" at offset ${r.pos}`);
      default:
        return Array.from(r.floats(COMPONENTS[type]!));
    }
  };

  const readArray = (el: DmElement, attr: string, baseId: number): AttrValue => {
    const n = r.i32();
    const type = ATTR_TYPES[baseId - 1] as AttrType | undefined;
    switch (type) {
      case 'element': {
        const arr: (DmElement | null)[] = new Array(n).fill(null);
        for (let i = 0; i < n; i++) {
          const idx = r.i32();
          if (idx === -2) r.cstr();
          else if (idx >= 0) refs.push({ el, attr, index: i, target: idx });
        }
        return arr;
      }
      case 'int':
        return r.ints(n);
      case 'bool':
      case 'uint8': {
        const out = new Int32Array(n);
        for (let i = 0; i < n; i++) out[i] = r.u8();
        return out;
      }
      case 'string': {
        // Strings inside arrays are always inline, never string-table refs.
        const out: string[] = [];
        for (let i = 0; i < n; i++) out.push(r.cstr());
        return out;
      }
      case 'binary': {
        const out: Uint8Array[] = [];
        for (let i = 0; i < n; i++) out.push(r.bytes(r.i32()));
        return out as unknown as AttrValue;
      }
      case 'time': {
        const ints = r.ints(n);
        return Float32Array.from(ints, (t) => t / 10000);
      }
      case 'color': {
        const out = new Float32Array(n * 4);
        for (let i = 0; i < n * 4; i++) out[i] = r.u8();
        return out;
      }
      case 'uint64': {
        const out = new BigInt64Array(n);
        for (let i = 0; i < n; i++) {
          const lo = BigInt(r.i32() >>> 0);
          const hi = BigInt(r.i32() >>> 0);
          out[i] = (hi << 32n) | lo;
        }
        return out;
      }
      case undefined:
        throw new Error(`Unknown array type ${baseId + arrayBase} for "${attr}" at offset ${r.pos}`);
      default:
        return r.floats(n * COMPONENTS[type]!);
    }
  };

  const readAttributes = (el: DmElement) => {
    const count = r.i32();
    for (let a = 0; a < count; a++) {
      const name = nameRef();
      const typeId = r.u8();
      el.attrs.set(name, readValue(el, name, typeId));
    }
  };

  if (v >= 9) {
    // Prefix elements carry file-level metadata (e.g. "asset info"); read and discard. Their attribute names
    // come before the string table, so they are inline strings.
    const prefixCount = r.i32();
    for (let p = 0; p < prefixCount; p++) {
      const count = r.i32();
      for (let a = 0; a < count; a++) {
        r.cstr();
        const typeId = r.u8();
        skipPrefixValue(r, typeId, arrayBase);
      }
    }
  }

  if (v >= 2) {
    const count = v >= 4 ? r.i32() : r.i16();
    strings = new Array(count);
    for (let i = 0; i < count; i++) strings[i] = r.cstr();
  }

  const elementCount = r.i32();
  if (elementCount < 0 || elementCount > 10_000_000) throw new Error(`Implausible element count ${elementCount}`);
  const elements: DmElement[] = [];
  for (let i = 0; i < elementCount; i++) {
    const type = nameRef();
    const name = v >= 4 ? strRef() : r.cstr();
    const id = guidString(r.bytes(16));
    elements.push(new DmElement(type, name, id));
  }
  for (const el of elements) readAttributes(el);

  for (const ref of refs) {
    const target = elements[ref.target] ?? null;
    if (ref.index < 0) ref.el.attrs.set(ref.attr, target);
    else (ref.el.attrs.get(ref.attr) as (DmElement | null)[])[ref.index] = target;
  }
  // Binary keeps the name in the element header; keyvalues2 has it as an attribute. Expose it both ways.
  for (const el of elements) {
    if (!el.attrs.has('name')) el.attrs.set('name', el.name);
    else if (!el.name) el.name = el.str('name') ?? '';
  }
  if (!elements.length) throw new Error('DMX file has no elements');

  return {
    encoding: header.encoding,
    encodingVersion: v,
    format: header.format,
    formatVersion: header.formatVersion,
    root: elements[0],
    elements,
  };
}

/** Prefix attributes use inline strings for everything; only simple scalar types are expected there. */
function skipPrefixValue(r: Reader, typeId: number, arrayBase: number) {
  if (typeId > arrayBase) {
    const base = typeId - arrayBase;
    const n = r.i32();
    for (let i = 0; i < n; i++) skipPrefixValue(r, base, arrayBase);
    return;
  }
  const type = ATTR_TYPES[typeId - 1];
  switch (type) {
    case 'element':
    case 'int':
    case 'float':
    case 'time':
      r.pos += 4;
      return;
    case 'bool':
    case 'uint8':
      r.pos += 1;
      return;
    case 'string':
      r.cstr();
      return;
    case 'binary':
      r.pos += r.i32();
      return;
    case 'color':
      r.pos += 4;
      return;
    case 'uint64':
      r.pos += 8;
      return;
    default:
      if (type && COMPONENTS[type]) {
        r.pos += 4 * COMPONENTS[type]!;
        return;
      }
      throw new Error(`Unknown prefix attribute type ${typeId}`);
  }
}
