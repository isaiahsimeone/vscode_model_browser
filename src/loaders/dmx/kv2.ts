// Reader for DMX "keyvalues2" (text) encoding.
//
//   "DmeModel"                       <- element: class name, then { attributes }
//   {
//     "id" "elementid" "<guid>"
//     "name" "string" "foo"
//     "transform" "DmeTransform" { ... }        <- inline element
//     "children" "element_array" [ "element" "<guid>", "DmeDag" { ... } ]
//     "position$0" "vector3_array" [ "1 2 3", "4 5 6" ]
//   }

import { COMPONENTS, DmElement, type AttrType, type AttrValue, type Datamodel, type DmxHeader } from './datamodel';

const enum Tok {
  Str,
  LBrace,
  RBrace,
  LBracket,
  RBracket,
  End,
}

class Lexer {
  pos: number;
  value = '';
  constructor(
    private s: string,
    start: number,
  ) {
    this.pos = start;
  }

  next(): Tok {
    const s = this.s;
    for (;;) {
      if (this.pos >= s.length) return Tok.End;
      const c = s.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x2c /* , */) {
        this.pos++;
        continue;
      }
      if (c === 0x2f && s.charCodeAt(this.pos + 1) === 0x2f) {
        // `//` comment
        const nl = s.indexOf('\n', this.pos);
        this.pos = nl < 0 ? s.length : nl + 1;
        continue;
      }
      break;
    }
    const c = s[this.pos];
    switch (c) {
      case '{':
        this.pos++;
        return Tok.LBrace;
      case '}':
        this.pos++;
        return Tok.RBrace;
      case '[':
        this.pos++;
        return Tok.LBracket;
      case ']':
        this.pos++;
        return Tok.RBracket;
      case '"': {
        let end = s.indexOf('"', this.pos + 1);
        // Escaped quotes are rare in model files; handle them anyway.
        while (end > 0 && s[end - 1] === '\\') end = s.indexOf('"', end + 1);
        if (end < 0) throw new Error(`Unterminated string at ${this.pos}`);
        const raw = s.slice(this.pos + 1, end);
        this.value = raw.includes('\\') ? raw.replace(/\\(.)/g, (_, ch) => (ch === 'n' ? '\n' : ch === 't' ? '\t' : ch)) : raw;
        this.pos = end + 1;
        return Tok.Str;
      }
      default:
        throw new Error(`Unexpected character '${c}' at ${this.pos}`);
    }
  }

  expect(t: Tok, what: string): void {
    if (this.next() !== t) throw new Error(`Expected ${what} near offset ${this.pos}`);
  }
  str(what: string): string {
    this.expect(Tok.Str, what);
    return this.value;
  }
}

interface Pending {
  el: DmElement;
  attr: string;
  index: number; // -1 for a single element attr
  guid: string;
}

export function readKeyValues2(text: string, header: DmxHeader): Datamodel {
  const lx = new Lexer(text, header.length);
  const byId = new Map<string, DmElement>();
  const all: DmElement[] = [];
  const pending: Pending[] = [];
  const top: DmElement[] = [];

  const readElement = (type: string): DmElement => {
    lx.expect(Tok.LBrace, '{');
    const el = new DmElement(type, '', '');
    all.push(el);
    for (;;) {
      const t = lx.next();
      if (t === Tok.RBrace) break;
      if (t !== Tok.Str) throw new Error(`Expected attribute name near offset ${lx.pos}`);
      const name = lx.value;
      const atype = lx.str(`type of "${name}"`);
      if (atype === 'elementid') {
        el.id = lx.str('guid');
        byId.set(el.id, el);
        continue;
      }
      if (atype === 'element') {
        const guid = lx.str('guid');
        el.attrs.set(name, null);
        if (guid) pending.push({ el, attr: name, index: -1, guid });
        continue;
      }
      if (atype === 'element_array') {
        lx.expect(Tok.LBracket, '[');
        const arr: (DmElement | null)[] = [];
        for (;;) {
          const tt = lx.next();
          if (tt === Tok.RBracket) break;
          if (tt !== Tok.Str) throw new Error(`Bad element_array near offset ${lx.pos}`);
          const cls = lx.value;
          if (cls === 'element') {
            const guid = lx.str('guid');
            if (guid) pending.push({ el, attr: name, index: arr.length, guid });
            arr.push(null);
          } else {
            arr.push(readElement(cls));
          }
        }
        el.attrs.set(name, arr);
        continue;
      }
      if (atype.endsWith('_array')) {
        lx.expect(Tok.LBracket, '[');
        const items: string[] = [];
        for (;;) {
          const tt = lx.next();
          if (tt === Tok.RBracket) break;
          if (tt !== Tok.Str) throw new Error(`Bad ${atype} near offset ${lx.pos}`);
          items.push(lx.value);
        }
        el.attrs.set(name, arrayValue(atype.slice(0, -6) as AttrType, items));
        continue;
      }
      // Anything else: either a scalar type, or the class name of an inline element.
      const save = lx.pos;
      const tt = lx.next();
      if (tt === Tok.LBrace) {
        lx.pos = save;
        el.attrs.set(name, readElement(atype));
        continue;
      }
      if (tt !== Tok.Str) throw new Error(`Expected value for "${name}" near offset ${lx.pos}`);
      el.attrs.set(name, scalarValue(atype as AttrType, lx.value));
    }
    el.name = el.str('name') ?? '';
    return el;
  };

  for (;;) {
    const t = lx.next();
    if (t === Tok.End) break;
    if (t !== Tok.Str) throw new Error(`Expected element class near offset ${lx.pos}`);
    top.push(readElement(lx.value));
  }
  if (!top.length) throw new Error('DMX file has no elements');

  for (const p of pending) {
    const target = byId.get(p.guid) ?? null;
    if (p.index < 0) p.el.attrs.set(p.attr, target);
    else (p.el.attrs.get(p.attr) as (DmElement | null)[])[p.index] = target;
  }

  return {
    encoding: header.encoding,
    encodingVersion: header.encodingVersion,
    format: header.format,
    formatVersion: header.formatVersion,
    root: top[0],
    elements: all,
  };
}

function numbers(s: string): number[] {
  const out: number[] = [];
  for (const p of s.split(/\s+/)) if (p) out.push(+p);
  return out;
}

function scalarValue(type: AttrType, v: string): AttrValue {
  switch (type) {
    case 'int':
    case 'float':
    case 'time':
    case 'uint8':
      return +v;
    case 'uint64':
      return +v; // precision loss is fine for display purposes
    case 'bool':
      return v === '1' || v === 'true';
    case 'string':
      return v;
    case 'binary': {
      const hex = v.replace(/\s+/g, '');
      const out = new Uint8Array(hex.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    }
    default:
      if (COMPONENTS[type]) return numbers(v);
      return v; // unknown type: keep the raw text
  }
}

function arrayValue(type: AttrType, items: string[]): AttrValue {
  switch (type) {
    case 'string':
      return items;
    case 'int':
    case 'uint8':
    case 'bool': {
      const out = new Int32Array(items.length);
      for (let i = 0; i < items.length; i++) out[i] = type === 'bool' ? (items[i] === '1' || items[i] === 'true' ? 1 : 0) : +items[i];
      return out;
    }
    case 'uint64': {
      const out = new BigInt64Array(items.length);
      for (let i = 0; i < items.length; i++) out[i] = BigInt(items[i]);
      return out;
    }
    case 'binary':
      return items.map((s) => scalarValue('binary', s)) as unknown as AttrValue;
    default: {
      const n = COMPONENTS[type] ?? 1;
      const out = new Float32Array(items.length * n);
      let k = 0;
      for (const item of items) {
        if (n === 1) {
          out[k++] = +item;
          continue;
        }
        let start = 0;
        for (let c = 0; c < n; c++) {
          while (item.charCodeAt(start) === 0x20) start++;
          let end = item.indexOf(' ', start);
          if (end < 0) end = item.length;
          out[k++] = +item.slice(start, end);
          start = end + 1;
        }
      }
      return out;
    }
  }
}
