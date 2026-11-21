// Valve's Datamodel: a graph of typed elements, each a bag of typed attributes. The binary and keyvalues2
// readers both produce this, and everything downstream (toMesh) only sees this.

export type AttrValue =
  | null
  | number
  | boolean
  | string
  | number[] // vector2/3/4, qangle, quaternion, color, matrix
  | Uint8Array // binary
  | DmElement
  | (DmElement | null)[] // element_array
  | string[] // string_array
  | Float32Array // float/vector/quaternion/... arrays, flattened
  | Int32Array // int/bool/uint8 arrays
  | BigInt64Array; // uint64 arrays

export class DmElement {
  readonly attrs = new Map<string, AttrValue>();
  constructor(
    public type: string,
    public name: string,
    public id: string,
  ) {}

  get(name: string): AttrValue | undefined {
    return this.attrs.get(name);
  }
  element(name: string): DmElement | null {
    const v = this.attrs.get(name);
    return v instanceof DmElement ? v : null;
  }
  elements(name: string): DmElement[] {
    const v = this.attrs.get(name);
    return Array.isArray(v) ? (v.filter((e) => e instanceof DmElement) as DmElement[]) : [];
  }
  floats(name: string): Float32Array | undefined {
    const v = this.attrs.get(name);
    return v instanceof Float32Array ? v : undefined;
  }
  ints(name: string): Int32Array | undefined {
    const v = this.attrs.get(name);
    return v instanceof Int32Array ? v : undefined;
  }
  vec(name: string): number[] | undefined {
    const v = this.attrs.get(name);
    return Array.isArray(v) && typeof v[0] === 'number' ? (v as number[]) : undefined;
  }
  str(name: string): string | undefined {
    const v = this.attrs.get(name);
    return typeof v === 'string' ? v : undefined;
  }
  strings(name: string): string[] {
    const v = this.attrs.get(name);
    return Array.isArray(v) ? (v.filter((s) => typeof s === 'string') as string[]) : [];
  }
}

export interface Datamodel {
  encoding: string;
  encodingVersion: number;
  format: string;
  formatVersion: number;
  root: DmElement;
  elements: DmElement[];
}

/** Base attribute types, in the order the binary format numbers them (1-based). */
export const ATTR_TYPES = [
  'element',
  'int',
  'float',
  'bool',
  'string',
  'binary',
  'time',
  'color',
  'vector2',
  'vector3',
  'vector4',
  'qangle',
  'quaternion',
  'matrix',
  'uint64',
  'uint8',
] as const;
export type AttrType = (typeof ATTR_TYPES)[number];

/** Components per value for the fixed-size numeric types. */
export const COMPONENTS: Partial<Record<AttrType, number>> = {
  float: 1,
  time: 1,
  color: 4,
  vector2: 2,
  vector3: 3,
  vector4: 4,
  qangle: 3,
  quaternion: 4,
  matrix: 16,
};

export interface DmxHeader {
  encoding: string;
  encodingVersion: number;
  format: string;
  formatVersion: number;
  /** Byte length of the header line, including its terminating newline. */
  length: number;
}

export function parseHeader(head: string): DmxHeader | undefined {
  const m = /^<!--\s*dmx encoding (\S+) (\d+) format (\S+) (\d+)\s*-->\r?\n?/.exec(head);
  if (!m) return undefined;
  return {
    encoding: m[1],
    encodingVersion: +m[2],
    format: m[3],
    formatVersion: +m[4],
    length: m[0].length,
  };
}
