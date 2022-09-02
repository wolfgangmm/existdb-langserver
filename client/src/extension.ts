/**
 * XQuery/eXistdb extension for Visual Studio Code
 * 
 * @author Wolfgang Meier
 */
import { ExistTaskProvider } from './task-provider';
import * as path from 'path';
import {
	workspace as Workspace, window as Window, languages as Languages, ExtensionContext, TextDocument, OutputChannel,
	WorkspaceFolder, Uri, Disposable, tasks, commands, StatusBarAlignment, ViewColumn, ProgressLocation,
	Task, TaskExecution, QuickPickItem
} from 'vscode';
import { LanguageClient, LanguageClientOptions, TransportKind, GenericNotificationHandler, RevealOutputChannelOn } from "vscode-languageclient/node";
import QueryResultsProvider from './query-results-provider';

class TaskPickItem implements QuickPickItem {
	label: string;
	task?: Task;
	execution?: TaskExecution;
}

const BINARIES_DIR = 'dist';

let context: ExtensionContext;
let onStatus : GenericNotificationHandler;

let defaultClient: LanguageClient;
let clients: Map<string, LanguageClient> = new Map();

let outputChannel: OutputChannel = Window.createOutputChannel('eXistdb Language Server');

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

function onXarInstallRequest(client: LanguageClient, message: string, xar: string): void {
	Window.showWarningMessage(message.toString(), 'Install').then((action) => {
		if (action) {
			Window.withProgress({
				location: ProgressLocation.Notification,
				title: "Installing helper xar",
				cancellable: false
			}, (progress) => {
				return client.sendRequest('workspace/executeCommand', {
					command: 'deploy',
					arguments: [xar]
				});
			});
		}
	});
}

function startClient(folder?: WorkspaceFolder) {
	let module = context.asAbsolutePath(path.join('server', BINARIES_DIR, 'server.js'));
	if (!folder) {
		if (defaultClient) {
			return defaultClient;
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
			defaultClient.onNotification('existdb/install', (params) => {
				onXarInstallRequest(defaultClient, params[0], params[1]);
			});
			defaultClient.onNotification('existdb/status', onStatus);
		});
		defaultClient.start();
		return defaultClient;
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
			client.onNotification('existdb/install', (params) => {
				onXarInstallRequest(client, params[0], params[1]);
			});
			client.onNotification('existdb/status', onStatus);
		});
		client.start();
		clients.set(folder.uri.toString(), client);
		return client;
	}
	return clients.get(folder.uri.toString());
}

export function activate(extensionContext: ExtensionContext) {
	context = extensionContext;
	let syncScript = context.asAbsolutePath(path.join('sync', BINARIES_DIR, 'sync.js'));
	
	const resultsProvider = new QueryResultsProvider();
	const registration = Workspace.registerTextDocumentContentProvider("xmldb-query", resultsProvider);
	context.subscriptions.push(registration);

	const statusbar = Window.createStatusBarItem(StatusBarAlignment.Right, 100);

	onStatus = function(args: string[]) {
		statusbar.text = `${args[0]}`;
		statusbar.tooltip = `eXist-db: ${args[1]}`;
		statusbar.show();
	}

	const taskStatusbar = Window.createStatusBarItem(StatusBarAlignment.Right, 100);
	taskStatusbar.text = "$(sync-ignored) off";
	taskStatusbar.tooltip = "eXist-db: click to configure automatic synchronization";
	taskStatusbar.command = "existdb.control-sync";
	taskStatusbar.show();

	function checkSyncTasks() {
		const running = [];
		tasks.taskExecutions.forEach((exec) => {
			if (exec.task.name && exec.task.name.startsWith('sync-')) {
				running.push(exec.task.name.substring(5));
			}
		});
		if (running.length === 0) {
			taskStatusbar.text = "$(sync-ignored) off";
		} else {
			taskStatusbar.text = `$(sync) ${running.join(' | ')}`;
		}
	}
	tasks.onDidStartTask(checkSyncTasks);
	tasks.onDidEndTask(checkSyncTasks);

	function didOpenTextDocument(document: TextDocument): void {
		// We are only interested in language mode text
		if (document.languageId !== 'xquery' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
			return;
		}

		let uri = document.uri;
		let folder = Workspace.getWorkspaceFolder(uri);
		// Untitled files go to a default client.
		if (!folder || uri.scheme === 'untitled') {
			startClient();
		}
	}

	initTasks(syncScript);

	Workspace.workspaceFolders.forEach(folder => startClient(folder));

	// Workspace.onDidOpenTextDocument(didOpenTextDocument);
	// Workspace.textDocuments.forEach(didOpenTextDocument);
	Workspace.onDidChangeWorkspaceFolders((event) => {
		for (let folder of event.removed) {
			let client = clients.get(folder.uri.toString());
			if (client) {
				clients.delete(folder.uri.toString());
				client.stop();
			}
		}
		event.added.forEach(folder => startClient(folder));
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

	command = commands.registerCommand('existdb.control-sync', (ev) => {
		let picks: TaskPickItem[] = [];
		tasks.fetchTasks().then((t) => {
			t.forEach((task) => {
				Workspace.workspaceFolders.forEach((folder) => {
					const name = `sync-${folder.name}`;
					if (task.name === name) {
						const exec = tasks.taskExecutions.find((exec) => exec.task.name === name);
						let item: TaskPickItem;
						if (exec) {
							item = {
								label: `$(sync) ${folder.name}: stop synchronization`,
								execution: exec
							};
							picks.push(item);
						} else {
							item = {
								label: `$(sync-ignored) ${folder.name}: start synchronization`,
								task: task
							};
							picks.push(item);
						}
					}
				});
			});
			Window.showQuickPick(picks, { placeHolder: 'root directory', canPickMany: false })
				.then((pick) => {
					if (pick.execution) {
						pick.execution.terminate();
					} else if (pick.task) {
						tasks.executeTask(pick.task);
					}
				});
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
								let lang;
								switch (result.output) {
									case 'adaptive':
										lang = 'xquery';
										break;
									case 'html':
									case 'html5':
										lang = 'html';
										break;
									case 'json':
										lang = 'json';
										break;
									default:
										lang = 'xml';
								}
								resultsProvider.update(content);
								Workspace.openTextDocument(resultsProvider.queryResultsUri).then((document) => {
									Languages.setTextDocumentLanguage(document, lang);
									Window.showTextDocument(document, { viewColumn: ViewColumn.Beside, preview: true, preserveFocus: true });
								});
							}
							resolve(null);
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

	command = commands.registerCommand('existdb.deploy', (ev) => {
		if (ev && ev.path) {
			deploy({ path: ev.path });
		} else {
			Workspace.findFiles('**/*.xar')
				.then((uris) => {
					const xars = uris.map((uri) => uri.fsPath);
					Window.showQuickPick(xars)
						.then((xar) => {
							deploy({ path: xar });
						});
				});
		}
	});
	context.subscriptions.push(command);
}

function deploy(xar: any) {
	let client;
	const editor = Window.activeTextEditor;
	if (editor) {
		const uri = editor.document.uri;
		let folder = Workspace.getWorkspaceFolder(editor.document.uri);
		if (folder && uri.scheme !== 'untitled') {
			folder = getOuterMostWorkspaceFolder(folder);
			client = clients.get(folder.uri.toString());
		}
	}
	if (!client) {
		if (clients.size > 0) {
			client = clients.values().next().value;
		} else {
			client = startClient();
		}
	}
	Window.withProgress({
		location: ProgressLocation.Notification,
		title: `Installing xar ${xar.path}`,
		cancellable: false
	}, (progress) => {
		return client.sendRequest('workspace/executeCommand', {
			command: 'deploy',
			arguments: [xar]
		});
	});
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
	context = undefined;
	onStatus = undefined;
	return Promise.all(promises).then(() => undefined);
}