// Minimal reader for KeyValues3 text (used by .vmdl and other Source 2 source files).
//   <!-- kv3 encoding:text:version{…} format:… -->
//   { key = value  key2 = [ 1, 2, ] obj = { … } flagged = resource:"path" multiline = """…""" }

export type KV3 = null | boolean | number | string | KV3[] | { [key: string]: KV3 };

export function parseKV3(text: string): KV3 {
  let i = 0;
  const s = text;
  if (s.startsWith('<!--')) {
    const end = s.indexOf('-->');
    i = end < 0 ? s.length : end + 3;
  }

  const ws = () => {
    for (;;) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') i++;
      else if (c === '/' && s[i + 1] === '/') {
        const nl = s.indexOf('\n', i);
        i = nl < 0 ? s.length : nl + 1;
      } else if (c === '/' && s[i + 1] === '*') {
        const e = s.indexOf('*/', i + 2);
        i = e < 0 ? s.length : e + 2;
      } else return;
    }
  };

  const err = (msg: string) => {
    const line = s.slice(0, i).split('\n').length;
    return new Error(`KV3: ${msg} on line ${line}`);
  };

  const quoted = (): string => {
    if (s.startsWith('"""', i)) {
      const end = s.indexOf('"""', i + 3);
      if (end < 0) throw err('unterminated """ string');
      let body = s.slice(i + 3, end);
      i = end + 3;
      body = body.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      return body;
    }
    let out = '';
    i++; // opening quote
    for (;;) {
      if (i >= s.length) throw err('unterminated string');
      const c = s[i++];
      if (c === '"') return out;
      if (c === '\\') {
        const n = s[i++];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else out += c;
    }
  };

  const bare = (): string => {
    const start = i;
    while (i < s.length && /[^\s=,{}\[\]"]/.test(s[i])) i++;
    if (i === start) throw err(`unexpected '${s[i] ?? 'end of file'}'`);
    return s.slice(start, i);
  };

  const value = (): KV3 => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const obj: { [k: string]: KV3 } = {};
      for (;;) {
        ws();
        if (s[i] === '}') {
          i++;
          return obj;
        }
        if (i >= s.length) throw err('unterminated object');
        const key = s[i] === '"' ? quoted() : bare();
        ws();
        if (s[i] !== '=') throw err(`expected '=' after ${key}`);
        i++;
        obj[key] = value();
      }
    }
    if (c === '[') {
      i++;
      const arr: KV3[] = [];
      for (;;) {
        ws();
        if (s[i] === ']') {
          i++;
          return arr;
        }
        if (i >= s.length) throw err('unterminated array');
        arr.push(value());
      }
    }
    if (c === '"') return quoted();
    const word = bare();
    // flagged value, e.g. resource:"models/foo.vmdl" or resource_name:"…"
    if (word.endsWith(':') && s[i] === '"') return quoted();
    if (word.includes(':') && !/^-?[\d.]/.test(word)) {
      const rest = word.slice(word.indexOf(':') + 1);
      if (rest) return rest;
      return value();
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (word.startsWith('#[')) return word; // binary blob marker; not needed here
    const n = Number(word);
    return Number.isNaN(n) ? word : n;
  };

  const v = value();
  return v;
}

/** Depth-first walk over every object node in a KV3 tree. */
export function* kv3Objects(node: KV3): Generator<{ [k: string]: KV3 }> {
  if (Array.isArray(node)) for (const n of node) yield* kv3Objects(n);
  else if (node && typeof node === 'object') {
    yield node;
    for (const v of Object.values(node)) yield* kv3Objects(v);
  }
}
