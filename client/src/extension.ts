/**
 * XQuery/eXistdb extension for Visual Studio Code
 * 
 * @author Wolfgang Meier
 */
import { ExistTaskProvider } from './task-provider';
import * as path from 'path';
import {
	workspace as Workspace, window as Window, ExtensionContext, TextDocument, OutputChannel,
	WorkspaceFolder, Uri, Disposable, tasks, commands, StatusBarAlignment, Position, ViewColumn, ProgressLocation
} from 'vscode';

import {
	LanguageClient, LanguageClientOptions, TransportKind, RevealOutputChannelOn
} from 'vscode-languageclient';

const BINARIES_DIR = 'dist';

let defaultClient: LanguageClient;
let clients: Map<string, LanguageClient> = new Map();

let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
	if (_sortedWorkspaceFolders === void 0) {
		_sortedWorkspaceFolders = Workspace.workspaceFolders ? Workspace.workspaceFolders.map(folder => {
			let result = folder.uri.toString();
			if (result.charAt(result.length - 1) !== '/') {
				result = result + '/';
			}
			return result;
		}).sort(
			(a, b) => {
				return a.length - b.length;
			}
		) : [];
	}
	return _sortedWorkspaceFolders;
}
Workspace.onDidChangeWorkspaceFolders(() => _sortedWorkspaceFolders = undefined);

function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
	let sorted = sortedWorkspaceFolders();
	for (let element of sorted) {
		let uri = folder.uri.toString();
		if (uri.charAt(uri.length - 1) !== '/') {
			uri = uri + '/';
		}
		if (uri.startsWith(element)) {
			return Workspace.getWorkspaceFolder(Uri.parse(element))!;
		}
	}
	return folder;
}

let taskProvider: Disposable | undefined;

function onXarInstallRequest(client: LanguageClient, message: string, xar): void {
	Window.showInformationMessage(message, 'Install').then((action) => {
		if (action) {
			client.sendNotification('existdb/install', [xar]);
		}
	});
}

export function activate(context: ExtensionContext) {
	let syncScript = context.asAbsolutePath(path.join('sync', BINARIES_DIR, 'sync.js'));
	let module = context.asAbsolutePath(path.join('server', BINARIES_DIR, 'server.js'));
	let outputChannel: OutputChannel = Window.createOutputChannel('eXistdb Language Server');
	const statusbar = Window.createStatusBarItem(StatusBarAlignment.Right, 100);

	function onStatus(status: string, uri: string) {
		statusbar.text = `${status}`;
		statusbar.tooltip = `eXist-db: ${uri}`;
		statusbar.show();
	}

	function didOpenTextDocument(document: TextDocument): void {
		// We are only interested in language mode text
		if (document.languageId !== 'xquery' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
			return;
		}

		let uri = document.uri;
		let folder = Workspace.getWorkspaceFolder(uri);
		// Untitled files go to a default client.
		if (!folder || uri.scheme === 'untitled') {
			if (defaultClient) {
				return;
			}
			let debugOptions = { execArgv: ["--nolazy", "--inspect=6010"] };
			let serverOptions = {
				run: { module, transport: TransportKind.ipc },
				debug: { module, transport: TransportKind.ipc, options: debugOptions }
			};
			let clientOptions: LanguageClientOptions = {
				documentSelector: [
					{ scheme: 'untitled', language: 'xquery' }
				],
				diagnosticCollectionName: 'existdb',
				outputChannel: outputChannel,
				initializationOptions: {
					resources: context.asAbsolutePath('resources')
				}
			};
			defaultClient = new LanguageClient('existdb-langserver', 'eXist Language Server', serverOptions, clientOptions);
			defaultClient.onReady().then(() => {
				defaultClient.onNotification('existdb/install', (message: string, xar) => {
					onXarInstallRequest(defaultClient, message, xar);
				});
				defaultClient.onNotification('existdb/status', onStatus);
			});
			defaultClient.start();
			return;
		}

		// If we have nested workspace folders we only start a server on the outer most workspace folder.
		folder = getOuterMostWorkspaceFolder(folder);

		if (!clients.has(folder.uri.toString())) {
			let debugOptions = { execArgv: ["--nolazy", `--inspect=${6011 + clients.size}`] };
			let serverOptions = {
				run: { module, transport: TransportKind.ipc },
				debug: { module, transport: TransportKind.ipc, options: debugOptions }
			};
			let clientOptions: LanguageClientOptions = {
				documentSelector: [
					{ scheme: 'file', language: 'xquery', pattern: `${folder.uri.fsPath}/**/*` }
				],
				diagnosticCollectionName: 'existdb',
				workspaceFolder: folder,
				outputChannel: outputChannel,
				revealOutputChannelOn: RevealOutputChannelOn.Never,
				initializationOptions: {
					workspaceFolder: folder.uri.toString(),
					resources: context.asAbsolutePath('resources')
				},
				synchronize: {
					// notify server if .existdb.json file is changeds
					fileEvents: Workspace.createFileSystemWatcher('**/.existdb.json')
				}
			};
			let client = new LanguageClient('existdb-langserver', 'eXist Language Server', serverOptions, clientOptions);
			client.onReady().then(() => {
				client.onNotification('existdb/install', (message: string, xar) => {
					onXarInstallRequest(client, message, xar);
				});
				client.onNotification('existdb/status', onStatus);
			});
			client.start();
			clients.set(folder.uri.toString(), client);
		}
	}

	initTasks(syncScript);

	Workspace.onDidOpenTextDocument(didOpenTextDocument);
	Workspace.textDocuments.forEach(didOpenTextDocument);
	Workspace.onDidChangeWorkspaceFolders((event) => {
		for (let folder of event.removed) {
			let client = clients.get(folder.uri.toString());
			if (client) {
				clients.delete(folder.uri.toString());
				client.stop();
			}
		}
	});

	let command = commands.registerCommand('existdb.reconnect', () => {
		const editor = Window.activeTextEditor;
		if (editor) {
			const uri = editor.document.uri;
			let folder = Workspace.getWorkspaceFolder(editor.document.uri);
			if ((!folder || uri.scheme === 'untitled')) {
				defaultClient.sendRequest('workspace/executeCommand', {
					command: 'reconnect'
				});
			} else {
				folder = getOuterMostWorkspaceFolder(folder);
				const client = clients.get(folder.uri.toString());
				if (client) {
					client.sendRequest('workspace/executeCommand', {
						command: 'reconnect'
					});
				}
			}
		}
	});
	context.subscriptions.push(command);

	command = commands.registerCommand('existdb.create-config', () => {
		Window.showWorkspaceFolderPick().then(folder => {
			if (!folder) {
				Window.showWarningMessage('Editor does not contain any workspace folders.');
				return;
			}
			folder = getOuterMostWorkspaceFolder(folder);
			const uri = folder.uri.toString();
			const client = clients.get(uri);
			if (client) {
				const result = client.sendRequest('workspace/executeCommand', {
					command: 'createConfig',
					arguments: [uri]
				});
				if (result) {
					result.then((path: string) => {
						Workspace.openTextDocument(Uri.file(path)).then(doc => {
							Window.showTextDocument(doc);
						});
					});
				}
			}
		});
	});
	context.subscriptions.push(command);

	command = commands.registerCommand('existdb.execute', () => {
		Window.withProgress({
			location: ProgressLocation.Notification,
			title: "Executing query!",
			cancellable: false
		}, (progress) => {
			return new Promise((resolve, reject) => {
				const editor = Window.activeTextEditor;
				if (editor) {
					const text = editor.document.getText();
					const uri = editor.document.uri;
					let folder = Workspace.getWorkspaceFolder(uri);
					let result;
					if ((!folder || uri.scheme === 'untitled')) {
						result = defaultClient.sendRequest('workspace/executeCommand', {
							command: 'execute',
							arguments: [uri.toString(), text]
						});
					} else {
						folder = getOuterMostWorkspaceFolder(folder);
						const client = clients.get(folder.uri.toString());
						if (client) {
							result = client.sendRequest('workspace/executeCommand', {
								command: 'execute',
								arguments: [uri.toString(), text]
							});
						}
					}
					if (result) {
						result.then((result) => {
							let content = result.results;
							if (result.hits) {
								let message = `Query returned ${result.hits} in ${result.elapsed}ms.`;
								if (result.hits > 100) {
									message += ' Showing first 100 results.';
								}
								switch (result.output) {
									case 'xml':
									case 'html':
									case 'html5':
										content = `<!-- ${message} -->\n${result.results}`;
										break;
									case 'json':
										content = result.results;
										break;
									default:
										content = `(:  ${message} :)\n${result.results}`;
										break;
								}
							}
							if (result.output === 'html' || result.output === 'html5' ||
								result.output === 'xhtml') {
								const panel = Window.createWebviewPanel(
									'existdb-query',
									'eXistdb Query Result',
									ViewColumn.Beside
								);

								panel.webview.html = content;
							} else {
								Workspace.openTextDocument({ content: content, language: result.output }).then((document) => {
									Window.showTextDocument(document, ViewColumn.Beside);
								});
							}
							resolve();
						}).catch((error) => {
							Window.showWarningMessage(`Could not query server: ${error}`);
							reject();
						});
					}
				}
			});
		});
	});
	context.subscriptions.push(command);


}

function initTasks(syncScript: string) {
	let workspaceFolders = Workspace.workspaceFolders;
	if (!Array.isArray(workspaceFolders) || workspaceFolders.length == 0) {
		return;
	}
	taskProvider = tasks.registerTaskProvider('existdb-sync', new ExistTaskProvider(workspaceFolders, syncScript));
}

export function deactivate(): Thenable<void> {
	if (taskProvider) {
		taskProvider.dispose();
	}
	let promises: Thenable<void>[] = [];
	if (defaultClient) {
		promises.push(defaultClient.stop());
	}
	for (let client of clients.values()) {
		promises.push(client.stop());
	}
	return Promise.all(promises).then(() => undefined);
}