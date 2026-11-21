// Verifies package.json's customEditors selectors cover exactly the extensions the loaders register.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { allExtensions } from '../src/loaders/registry';

const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const declared = new Set<string>(
  pkg.contributes.customEditors.flatMap((e: { selector: { filenamePattern: string }[] }) => e.selector.map((s) => s.filenamePattern.replace(/^\*/, ''))),
);
const registered = new Set(allExtensions());
const missing = [...registered].filter((e) => !declared.has(e));
const extra = [...declared].filter((e) => !registered.has(e));
if (missing.length || extra.length) {
  console.error(`package.json customEditors out of sync. Missing: ${missing.join(', ') || '-'}; not loadable: ${extra.join(', ') || '-'}`);
  process.exit(1);
}
console.log(`ok: ${[...registered].join(' ')}`);
