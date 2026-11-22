import * as path from 'node:path';
import * as vscode from 'vscode';
import { loaderFor, loadModel } from '../loaders/registry';
import type { ModelData } from '../loaders/types';
import { MissingToolError } from '../loaders/vmdlc';
import { loaderSettings } from '../settings';

/** Every model format opens in the viewer by default; the toolbar's Text button reopens a file as text. */
export const VIEW_TYPE = 'modelBrowser.viewer';

/** Messages sent to the webview. */
export type ToWebview =
  | { type: 'loading'; file: string }
  | { type: 'model'; file: string; loader: string; data: ModelData; ms: number }
  | { type: 'error'; file: string; message: string; action?: 'configureS2V' };

/** Messages received from the webview. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'reload' }
  | { type: 'openAsText' }
  | { type: 'revealInExplorer' }
  | { type: 'configureS2V' }
  | { type: 'state'; state: unknown };

class ModelDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose() {}
}

export class ModelEditorProvider implements vscode.CustomReadonlyEditorProvider<ModelDocument> {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  openCustomDocument(uri: vscode.Uri): ModelDocument {
    return new ModelDocument(uri);
  }

  async resolveCustomEditor(doc: ModelDocument, panel: vscode.WebviewPanel): Promise<void> {
    const webview = panel.webview;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    webview.options = { enableScripts: true, localResourceRoots: [media] };
    webview.html = this.html(webview, media);

    const file = doc.uri.fsPath;
    let abort: AbortController | undefined;
    const post = (m: ToWebview) => webview.postMessage(m);

    const load = async () => {
      abort?.abort();
      const ac = (abort = new AbortController());
      const loader = loaderFor(file);
      post({ type: 'loading', file: path.basename(file) });
      const t0 = Date.now();
      try {
        const run = () =>
          loadModel(file, {
            settings: loaderSettings(doc.uri),
            cacheDir: this.context.globalStorageUri.fsPath,
            log: (m) => this.output.appendLine(m),
            signal: ac.signal,
          });
        // Conversions through an external tool can take a moment; show progress for those.
        const data =
          loader?.id === 'vmdl_c'
            ? await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: `Converting ${path.basename(file)}` },
                run,
              )
            : await run();
        if (ac.signal.aborted) return;
        post({ type: 'model', file: path.basename(file), loader: loader?.label ?? '?', data, ms: Date.now() - t0 });
      } catch (e) {
        if (ac.signal.aborted) return;
        const err = e as Error;
        this.output.appendLine(`[${path.basename(file)}] ${err.stack ?? err.message}`);
        post({
          type: 'error',
          file: path.basename(file),
          message: err.message,
          action: e instanceof MissingToolError ? 'configureS2V' : undefined,
        });
      }
    };

    // Reload when the file changes on disk (e.g. after a rebuild).
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)),
    );
    let timer: NodeJS.Timeout | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    };
    watcher.onDidChange(soon);
    watcher.onDidCreate(soon);

    const sub = webview.onDidReceiveMessage(async (m: FromWebview) => {
      switch (m.type) {
        case 'ready':
        case 'reload':
          return load();
        case 'openAsText':
          return vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
        case 'revealInExplorer':
          return vscode.commands.executeCommand('revealInExplorer', doc.uri);
        case 'configureS2V':
          return vscode.commands.executeCommand('workbench.action.openSettings', 'modelBrowser.s2vPath');
      }
    });
    const cfg = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('modelBrowser', doc.uri)) load();
    });

    panel.onDidDispose(() => {
      abort?.abort();
      clearTimeout(timer);
      watcher.dispose();
      sub.dispose();
      cfg.dispose();
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join('');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'webview.css'));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `connect-src blob: data:`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
