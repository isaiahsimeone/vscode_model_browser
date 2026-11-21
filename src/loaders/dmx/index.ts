import { readFile } from 'node:fs/promises';
import type { ModelLoader } from '../types';
import { readBinary } from './binary';
import { parseHeader, type Datamodel } from './datamodel';
import { readKeyValues2 } from './kv2';
import { datamodelToModel } from './toMesh';

export function parseDmx(buf: Uint8Array): Datamodel {
  const head = new TextDecoder('latin1').decode(buf.subarray(0, Math.min(buf.length, 256)));
  const header = parseHeader(head);
  if (!header) throw new Error('Not a DMX file (missing "<!-- dmx encoding … -->" header)');
  if (header.encoding === 'binary') return readBinary(buf, header);
  if (header.encoding === 'keyvalues2' || header.encoding === 'keyvalues2_flat') {
    return readKeyValues2(new TextDecoder('utf-8').decode(buf), header);
  }
  throw new Error(`Unsupported DMX encoding "${header.encoding}"`);
}

export const dmxLoader: ModelLoader = {
  id: 'dmx',
  label: 'Valve DMX',
  extensions: ['.dmx'],
  async load(file) {
    const dm = parseDmx(new Uint8Array(await readFile(file)));
    const model = datamodelToModel(dm);
    model.notes = [`DMX ${dm.encoding} v${dm.encodingVersion}, format ${dm.format} v${dm.formatVersion}`, ...(model.notes ?? [])];
    return model;
  },
};
