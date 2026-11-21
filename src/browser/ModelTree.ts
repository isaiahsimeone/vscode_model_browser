// Sidebar: every model file in the workspace, as a folder tree with only the folders that contain models.

import * as path from 'node:path';
import * as vscode from 'vscode';
import { allExtensions, loaderFor } from '../loaders/registry';
import { excludeGlobs } from '../settings';
import { viewTypeFor } from '../editor/ModelEditorProvider';

interface FolderNode {
  kind: 'folder';
  name: string;
  path: string; // display path (relative)
  folders: Map<string, FolderNode>;
  files: FileNode[];
  count: number;
}
interface FileNode {
  kind: 'file';
  uri: vscode.Uri;
  name: string;
}
type Node = FolderNode | FileNode;

const folder = (name: string, p: string): FolderNode => ({ kind: 'folder', name, path: p, folders: new Map(), files: [], count: 0 });

export class ModelTree implements vscode.TreeDataProvider<Node> {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: FolderNode[] = [];
  private loaded?: Promise<void>;
  private filter = '';
  view?: vscode.TreeView<Node>;
  total = 0;

  constructor() {
    const glob = `**/*{${allExtensions().join(',')}}`;
    const watcher = vscode.workspace.createFileSystemWatcher(glob, false, true, false);
    let t: NodeJS.Timeout | undefined;
    const later = () => {
      clearTimeout(t);
      t = setTimeout(() => this.refresh(), 1000);
    };
    watcher.onDidCreate(later);
    watcher.onDidDelete(later);
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
  }

  refresh() {
    this.loaded = undefined;
    this.emitter.fire(undefined);
  }

  setFilter(text: string) {
    this.filter = text.trim().toLowerCase();
    void vscode.commands.executeCommand('setContext', 'modelBrowser.filtered', !!this.filter);
    this.refresh();
  }
  getFilter() {
    return this.filter;
  }

  private async scan() {
    const exts = allExtensions().map((e) => e.slice(1));
    const include = `**/*.{${exts.join(',')}}`;
    const exclude = excludeGlobs();
    const uris = await vscode.workspace.findFiles(include, exclude.length ? `{${exclude.join(',')}}` : undefined);
    const terms = this.filter.split(/\s+/).filter(Boolean);
    const byWs = new Map<string, FolderNode>();
    let total = 0;

    for (const uri of uris) {
      if (!loaderFor(uri.fsPath)) continue; // e.g. "foo.vmdl_c.bak"
      const ws = vscode.workspace.getWorkspaceFolder(uri);
      const rel = ws ? path.relative(ws.uri.fsPath, uri.fsPath) : uri.fsPath;
      if (terms.length) {
        const hay = rel.toLowerCase();
        if (!terms.every((t) => hay.includes(t))) continue;
      }
      const key = ws?.uri.toString() ?? '';
      let root = byWs.get(key);
      if (!root) byWs.set(key, (root = folder(ws?.name ?? '', '')));
      const parts = rel.split(/[\\/]/);
      const name = parts.pop()!;
      let node = root;
      node.count++;
      for (const p of parts) {
        let next = node.folders.get(p);
        if (!next) node.folders.set(p, (next = folder(p, node.path ? `${node.path}/${p}` : p)));
        node = next;
        node.count++;
      }
      node.files.push({ kind: 'file', uri, name });
      total++;
    }

    // Compress single-child chains ("work/cache/foo") like the explorer does.
    const compress = (n: FolderNode) => {
      for (const [k, child] of [...n.folders]) {
        let c = child;
        while (c.files.length === 0 && c.folders.size === 1) {
          const only = [...c.folders.values()][0];
          c = { ...only, name: `${c.name}/${only.name}` };
        }
        compress(c);
        n.folders.set(k, c);
      }
    };
    for (const r of byWs.values()) compress(r);

    this.roots = [...byWs.values()];
    this.total = total;
    if (this.view) {
      this.view.description = this.filter ? `“${this.filter}” · ${total}` : `${total}`;
      this.view.message = total ? undefined : this.filter ? `No models match “${this.filter}”.` : 'No model files in this workspace.';
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      this.loaded ??= this.scan();
      await this.loaded;
      if (this.roots.length === 1) return this.children(this.roots[0]);
      return this.roots;
    }
    return node.kind === 'folder' ? this.children(node) : [];
  }

  private children(n: FolderNode): Node[] {
    const folders = [...n.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    const files = [...n.files].sort((a, b) => a.name.localeCompare(b.name));
    return [...folders, ...files];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.name, this.filter ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${node.count}`;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'folder';
      return item;
    }
    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = node.uri;
    item.description = loaderFor(node.uri.fsPath)?.extensions.find((e) => node.name.toLowerCase().endsWith(e))?.slice(1);
    item.tooltip = node.uri.fsPath;
    item.iconPath = new vscode.ThemeIcon('symbol-misc');
    item.contextValue = 'model';
    item.command = { command: 'modelBrowser.preview', title: 'Open', arguments: [node.uri] };
    return item;
  }

  getParent(): undefined {
    return undefined;
  }
}

export function openModel(uri: vscode.Uri, preview = true) {
  return vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri.fsPath), { preview, preserveFocus: preview });
}
