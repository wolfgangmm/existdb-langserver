/**
 * XQuery/eXistdb extension for Visual Studio Code
 * 
 * @author Wolfgang Meier
 */
import { ExistTaskProvider } from './task-provider';
import * as path from 'path';
import * as fs from 'fs';
import {
	workspace as Workspace, window as Window, languages as Languages, ExtensionContext, TextDocument, OutputChannel,
	WorkspaceFolder, Uri, Disposable, tasks, commands, StatusBarAlignment, ViewColumn, ProgressLocation,
	Task, TaskExecution, QuickPickItem
} from 'vscode';
import { LanguageClient, LanguageClientOptions, TransportKind, GenericNotificationHandler, RevealOutputChannelOn } from "vscode-languageclient/node";
import QueryResultsProvider, { CursorState } from './query-results-provider';

class TaskPickItem implements QuickPickItem {
	label: string = '';
	task?: Task;
	execution?: TaskExecution;
}

const BINARIES_DIR = 'dist';

let context: ExtensionContext | undefined;
let onStatus : GenericNotificationHandler | undefined;

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

async function folderContainsFile(folder: WorkspaceFolder, filename: string): Promise<boolean> {
	const filePath = path.join(folder.uri.fsPath, filename);
	try {
		await fs.promises.access(filePath, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function shouldActivateForFolder(folder: WorkspaceFolder): Promise<boolean> {
	return (await folderContainsFile(folder, '.existdb.json')) || (await folderContainsFile(folder, 'expath-pkg.xml'));
}

let updateTaskStatusbarVisibilityFn: (() => Promise<void>) | undefined;

function watchForActivationFile(pattern: string, context: ExtensionContext): void {
	const watcher = Workspace.createFileSystemWatcher(pattern);
	watcher.onDidCreate(async (uri) => {
		const folder = Workspace.getWorkspaceFolder(uri);
		if (folder && !clients.has(folder.uri.toString())) {
			startClient(folder);
		}
		// Refresh tasks and status bar when .existdb.json is created
		if (pattern.includes('.existdb.json') && updateTaskStatusbarVisibilityFn) {
			refreshTasks();
			await updateTaskStatusbarVisibilityFn();
		}
	});
	watcher.onDidChange(async (uri) => {
		// Refresh tasks and status bar when .existdb.json is changed
		if (pattern.includes('.existdb.json') && updateTaskStatusbarVisibilityFn) {
			refreshTasks();
			await updateTaskStatusbarVisibilityFn();
		}
	});
	watcher.onDidDelete(async (uri) => {
		// Update status bar when .existdb.json is deleted
		if (pattern.includes('.existdb.json') && updateTaskStatusbarVisibilityFn) {
			refreshTasks();
			await updateTaskStatusbarVisibilityFn();
		}
	});
	context.subscriptions.push(watcher);
}

let taskProvider: Disposable | undefined;
let existTaskProvider: ExistTaskProvider | undefined;

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
	if (!context) {
		throw new Error('Extension context not initialized');
	}
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
		defaultClient.start().then(() => {
			defaultClient.onNotification('existdb/install', (params) => {
				onXarInstallRequest(defaultClient, params[0], params[1]);
			});
			if (onStatus) {
				defaultClient.onNotification('existdb/status', onStatus);
			}
		});
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
		client.start().then(() => {
			client.onNotification('existdb/install', (params) => {
				onXarInstallRequest(client, params[0], params[1]);
			});
			if (onStatus) {
				client.onNotification('existdb/status', onStatus);
			}
		});
		clients.set(folder.uri.toString(), client);

		if (!defaultClient) {
			defaultClient = client;
		}
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

	const statusbar = Window.createStatusBarItem(StatusBarAlignment.Right, 1);

	onStatus = function(args: string[]) {
		statusbar.text = `${args[0]}`;
		statusbar.tooltip = `eXist-db: ${args[1]}`;
		statusbar.show();
	}

	const taskStatusbar = Window.createStatusBarItem(StatusBarAlignment.Right, 2);
	taskStatusbar.text = "$(sync-ignored) off";
	taskStatusbar.tooltip = "eXist-db: click to configure automatic synchronization";
	taskStatusbar.command = "existdb.control-sync";

	// Output format status bar
	const formatStatusbar = Window.createStatusBarItem(StatusBarAlignment.Right, 0);
	function updateFormatStatusbar() {
		const config = Workspace.getConfiguration('existdb');
		const method = config.get<string>('query.serializationMethod', 'adaptive');
		const label = method.charAt(0).toUpperCase() + method.slice(1);
		formatStatusbar.text = `$(symbol-string) ${label}`;
		formatStatusbar.tooltip = 'eXist-db: click to change output format';
		formatStatusbar.command = 'existdb.setOutputFormat';
		formatStatusbar.show();
	}
	updateFormatStatusbar();
	Workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('existdb.query')) {
			updateFormatStatusbar();
		}
	});

	async function updateTaskStatusbarVisibility() {
		if (!Workspace.workspaceFolders || Workspace.workspaceFolders.length === 0) {
			taskStatusbar.hide();
			return;
		}
		let hasConfig = false;
		for (const folder of Workspace.workspaceFolders) {
			if (await folderContainsFile(folder, '.existdb.json')) {
				hasConfig = true;
				break;
			}
		}
		if (hasConfig) {
			taskStatusbar.show();
		} else {
			taskStatusbar.hide();
		}
	}
	updateTaskStatusbarVisibilityFn = updateTaskStatusbarVisibility;

	function checkSyncTasks() {
		const running: string[] = [];
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

	initTasks(syncScript);

	// Start clients for folders that contain .existdb.json or expath-pkg.xml
	if (Workspace.workspaceFolders) {
		Promise.all(Workspace.workspaceFolders.map(async (folder) => {
			if (await shouldActivateForFolder(folder)) {
				startClient(folder);
			}
		}));
	}

	// Update status bar visibility based on .existdb.json presence
	updateTaskStatusbarVisibility();

	// Watch for activation files being created
	watchForActivationFile('**/.existdb.json', context);
	watchForActivationFile('**/expath-pkg.xml', context);

	Workspace.onDidChangeWorkspaceFolders(async (event) => {
		for (let folder of event.removed) {
			let client = clients.get(folder.uri.toString());
			if (client) {
				clients.delete(folder.uri.toString());
				client.stop();
			}
		}
		// Only start clients for folders that contain .existdb.json or expath-pkg.xml
		for (let folder of event.added) {
			if (await shouldActivateForFolder(folder)) {
				startClient(folder);
			}
		}
		// Refresh tasks and update status bar when workspace folders change
		refreshTasks();
		updateTaskStatusbarVisibility();
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
					result.then((path: unknown) => {
						if (typeof path === 'string') {
							Workspace.openTextDocument(Uri.file(path)).then(doc => {
								Window.showTextDocument(doc);
							});
						}
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
				if (!Workspace.workspaceFolders) {
					return;
				}
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
					if (pick) {
						if (pick.execution) {
							pick.execution.terminate();
						} else if (pick.task) {
							tasks.executeTask(pick.task);
						}
					}
				});
		});
	});
	context.subscriptions.push(command);

	function getClientForUri(uri: Uri): LanguageClient | undefined {
		let folder = Workspace.getWorkspaceFolder(uri);
		if (!folder || uri.scheme === 'untitled') {
			return defaultClient;
		}
		folder = getOuterMostWorkspaceFolder(folder);
		return clients.get(folder.uri.toString());
	}

	function getSerializationOptions(queryText: string): Record<string, string> {
		const config = Workspace.getConfiguration('existdb');
		const options: Record<string, string> = {
			method: config.get<string>('query.serializationMethod', 'adaptive'),
			indent: config.get<boolean>('query.indent', true) ? 'yes' : 'no'
		};
		// Auto-enable highlight-matches for Lucene full-text queries
		if (/\bft:(query|search)\b/.test(queryText)) {
			options['highlight-matches'] = 'both';
		}
		return options;
	}

	function formatResultItems(items: any[], output: string): string {
		if (!Array.isArray(items) || items.length === 0) {
			return '';
		}
		return items.map((item: any) => {
			if (typeof item === 'string') {
				return item;
			}
			return item.value != null ? String(item.value) : '';
		}).join('\n');
	}

	function buildHeader(hits: number, elapsed: string | number, output: string, showing: number): string {
		let message = `Query returned ${hits} in ${elapsed}ms.`;
		if (hits > showing) {
			message += ` Showing ${showing} of ${hits} items.`;
		}
		switch (output) {
			case 'xml':
			case 'html':
			case 'html5':
				return `<!-- ${message} -->\n`;
			case 'json':
				return '';
			default:
				return `(:  ${message} :)\n`;
		}
	}

	function getLangForOutput(output: string): string {
		switch (output) {
			case 'adaptive':
				return 'xquery';
			case 'html':
			case 'html5':
				return 'html';
			case 'json':
				return 'json';
			default:
				return 'xml';
		}
	}

	function displayResults(queryResult: any, resultsProvider: QueryResultsProvider) {
		const hits = typeof queryResult.hits === 'string' ? parseInt(queryResult.hits) : (queryResult.hits || 0);
		const elapsed = queryResult.elapsed || '0';
		const output = queryResult.output || 'adaptive';

		// Cursor-based results: items come as array from cursor:fetch
		let content: string;
		let showing: number;
		if (queryResult.cursor && Array.isArray(queryResult.results)) {
			const formatted = formatResultItems(queryResult.results, output);
			showing = queryResult.results.length;
			content = buildHeader(hits, elapsed, output, showing) + formatted;

			// Track cursor state for paging
			resultsProvider.cursorState = {
				cursor: queryResult.cursor,
				hits,
				fetched: showing,
				output,
				pageSize: 100
			};
		} else {
			// Legacy string results
			content = queryResult.results || '';
			showing = Math.min(hits, 100);
			if (hits) {
				content = buildHeader(hits, elapsed, output, showing) + content;
			}
			resultsProvider.clearCursor();
		}

		if (output === 'html' || output === 'html5' || output === 'xhtml') {
			const panel = Window.createWebviewPanel(
				'existdb-query',
				'eXistdb Query Result',
				ViewColumn.Beside
			);
			panel.webview.html = content;
			resultsProvider.clearCursor();
		} else {
			const lang = getLangForOutput(output);
			resultsProvider.update(content);
			Workspace.openTextDocument(resultsProvider.queryResultsUri).then((document) => {
				Languages.setTextDocumentLanguage(document, lang);
				Window.showTextDocument(document, { viewColumn: ViewColumn.Beside, preview: true, preserveFocus: true });
			});
		}
	}

	command = commands.registerCommand('existdb.execute', () => {
		// Close any previous cursor before starting a new query
		if (resultsProvider.cursorState) {
			const prevCursor = resultsProvider.cursorState.cursor;
			resultsProvider.clearCursor();
			const editor = Window.activeTextEditor;
			if (editor) {
				const client = getClientForUri(editor.document.uri);
				if (client) {
					client.sendRequest('workspace/executeCommand', {
						command: 'closeCursor',
						arguments: [prevCursor]
					}).catch(() => {});
				}
			}
		}

		Window.withProgress({
			location: ProgressLocation.Notification,
			title: "Executing query!",
			cancellable: false
		}, (progress) => {
			return new Promise<void>((resolve, reject) => {
				const editor = Window.activeTextEditor;
				if (editor) {
					const text = editor.document.getText();
					const uri = editor.document.uri;
					const client = getClientForUri(uri);
					if (client) {
						const serializationOptions = getSerializationOptions(text);
						client.sendRequest('workspace/executeCommand', {
							command: 'execute',
							arguments: [uri.toString(), text, serializationOptions]
						}).then((queryResult: any) => {
							if (!queryResult || typeof queryResult !== 'object') {
								reject();
								return;
							}
							displayResults(queryResult, resultsProvider);
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

	command = commands.registerCommand('existdb.loadMoreResults', () => {
		const state = resultsProvider.cursorState;
		if (!state) {
			Window.showInformationMessage('No more results to load.');
			return;
		}
		if (state.fetched >= state.hits) {
			Window.showInformationMessage('All results have been loaded.');
			return;
		}
		const editor = Window.activeTextEditor;
		if (!editor) {
			return;
		}
		const client = getClientForUri(editor.document.uri);
		if (!client) {
			return;
		}

		Window.withProgress({
			location: ProgressLocation.Notification,
			title: "Loading more results...",
			cancellable: false
		}, () => {
			const start = state.fetched + 1;
			const count = state.pageSize;
			const queryText = editor.document.getText();
			const serializationOptions = getSerializationOptions(queryText);
			return client.sendRequest('workspace/executeCommand', {
				command: 'fetch',
				arguments: [state.cursor, start, count, serializationOptions]
			}).then((items: any) => {
				if (Array.isArray(items) && items.length > 0) {
					const page = '\n' + formatResultItems(items, state.output);
					state.fetched += items.length;
					resultsProvider.appendResults(page);
				}
				if (state.fetched >= state.hits) {
					// All results fetched — close cursor
					client.sendRequest('workspace/executeCommand', {
						command: 'closeCursor',
						arguments: [state.cursor]
					}).catch(() => {});
					resultsProvider.clearCursor();
					Window.showInformationMessage('All results loaded.');
				}
			}).catch((error) => {
				Window.showWarningMessage(`Failed to fetch results: ${error}`);
			});
		});
	});
	context.subscriptions.push(command);

	command = commands.registerCommand('existdb.setOutputFormat', () => {
		const config = Workspace.getConfiguration('existdb');
		const current = config.get<string>('query.serializationMethod', 'adaptive');
		const formats = [
			{ label: 'Adaptive', value: 'adaptive', description: 'XQuery default output' },
			{ label: 'XML', value: 'xml', description: 'XML serialization' },
			{ label: 'JSON', value: 'json', description: 'JSON serialization' },
			{ label: 'Text', value: 'text', description: 'Plain text' }
		];
		const items = formats.map(f => ({
			label: f.value === current ? `$(check) ${f.label}` : f.label,
			description: f.description,
			value: f.value
		}));
		Window.showQuickPick(items, { placeHolder: 'Select output format' }).then(pick => {
			if (pick) {
				config.update('query.serializationMethod', (pick as any).value, false);
			}
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
	let client: LanguageClient | undefined;
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
	if (!client) {
		return;
	}
	Window.withProgress({
		location: ProgressLocation.Notification,
		title: `Installing xar ${xar.path}`,
		cancellable: false
	}, (progress) => {
		if (!client) {
			return Promise.resolve();
		}
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
	existTaskProvider = new ExistTaskProvider(workspaceFolders, syncScript);
	taskProvider = tasks.registerTaskProvider('existdb-sync', existTaskProvider);
}

function refreshTasks() {
	if (existTaskProvider && Workspace.workspaceFolders) {
		existTaskProvider.updateWorkspaceFolders(Workspace.workspaceFolders);
	} else if (!existTaskProvider && context) {
		let syncScript = context.asAbsolutePath(path.join('sync', BINARIES_DIR, 'sync.js'));
		initTasks(syncScript);
	}
}

export function deactivate(): Promise<void> {
	if (taskProvider) {
		taskProvider.dispose();
	}
	let promises: Promise<void>[] = [];
	if (defaultClient) {
		promises.push(defaultClient.stop());
	}
	for (let client of clients.values()) {
		promises.push(client.stop());
	}
	return Promise.all(promises).then(() => undefined);
}