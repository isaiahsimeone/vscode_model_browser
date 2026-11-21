import { rm } from 'node:fs/promises';
import * as vscode from 'vscode';
import { ModelTree, openModel } from './browser/ModelTree';
import { allExtensions } from './loaders/registry';
import { ModelEditorProvider, VIEW_TYPE, VIEW_TYPE_TEXT, viewTypeFor } from './editor/ModelEditorProvider';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Model Browser');
  const tree = new ModelTree();
  const view = vscode.window.createTreeView('modelBrowser.files', { treeDataProvider: tree, showCollapseAll: true });
  tree.view = view;
  const provider = new ModelEditorProvider(context, output);
  const editorOptions = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true };
  void vscode.commands.executeCommand('setContext', 'modelBrowser.extensions', allExtensions());

  context.subscriptions.push(
    output,
    view,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, editorOptions),
    vscode.window.registerCustomEditorProvider(VIEW_TYPE_TEXT, provider, editorOptions),
    vscode.commands.registerCommand('modelBrowser.open', (uri?: vscode.Uri) => {
      uri ??= vscode.window.activeTextEditor?.document.uri;
      if (uri) return openModel(uri, false);
    }),
    vscode.commands.registerCommand('modelBrowser.preview', (uri: vscode.Uri) => openModel(uri, true)),
    vscode.commands.registerCommand('modelBrowser.openToSide', (uri?: vscode.Uri) => {
      if (uri) return vscode.commands.executeCommand('vscode.openWith', uri, viewTypeFor(uri.fsPath), vscode.ViewColumn.Beside);
    }),
    vscode.commands.registerCommand('modelBrowser.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('modelBrowser.filter', async () => {
      const text = await vscode.window.showInputBox({
        title: 'Filter models',
        prompt: 'Space-separated words; a model is shown when its path contains all of them',
        value: tree.getFilter(),
      });
      if (text !== undefined) tree.setFilter(text);
    }),
    vscode.commands.registerCommand('modelBrowser.clearFilter', () => tree.setFilter('')),
    vscode.commands.registerCommand('modelBrowser.revealInExplorer', (node?: { uri?: vscode.Uri }) => {
      if (node?.uri) return vscode.commands.executeCommand('revealInExplorer', node.uri);
    }),
    vscode.commands.registerCommand('modelBrowser.clearCache', async () => {
      await rm(context.globalStorageUri.fsPath, { recursive: true, force: true });
      vscode.window.showInformationMessage('Model Browser: conversion cache cleared.');
    }),
  );
}

export function deactivate() {}
