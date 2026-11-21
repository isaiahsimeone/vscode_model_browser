import * as os from 'node:os';
import * as vscode from 'vscode';
import type { LoaderSettings } from './loaders/types';

const expand = (p: string | undefined) => (p ? p.replace(/^~(?=$|[\\/])/, os.homedir()) : undefined);

/** Settings that apply to a given file (resource-scoped, so per-folder overrides work). */
export function loaderSettings(scope?: vscode.Uri): LoaderSettings {
  const c = vscode.workspace.getConfiguration('modelBrowser', scope);
  const folder = scope ? vscode.workspace.getWorkspaceFolder(scope)?.uri.fsPath : undefined;
  const rel = (p: string | undefined) => {
    const e = expand(p);
    if (!e) return undefined;
    return folder && !/^([a-zA-Z]:)?[\\/]/.test(e) ? `${folder}/${e}` : e;
  };
  return {
    s2vPath: rel(c.get<string>('s2vPath')) || undefined,
    gameInfo: rel(c.get<string>('gameInfo')) || undefined,
    contentRoots: (c.get<string[]>('contentRoots') ?? []).map((r) => rel(r)!).filter(Boolean),
  };
}

export function excludeGlobs(): string[] {
  return vscode.workspace.getConfiguration('modelBrowser').get<string[]>('exclude') ?? [];
}
