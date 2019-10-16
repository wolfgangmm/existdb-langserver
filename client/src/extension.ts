import { ExistTaskProvider } from './task-provider';
import * as path from 'path';
import {
	workspace as Workspace, window as Window, ExtensionContext, TextDocument, OutputChannel,
	WorkspaceFolder, Uri, Disposable, tasks
} from 'vscode';

import {
	LanguageClient, LanguageClientOptions, TransportKind
} from 'vscode-languageclient';

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
let workspaceFolder;
let taskProvider: Disposable | undefined;
let syncScript;

export function activate(context: ExtensionContext) {

	let syncScript = context.asAbsolutePath(path.join('sync', 'out', 'sync.js'));
	let module = context.asAbsolutePath(path.join('server', 'out', 'server.js'));
	let outputChannel: OutputChannel = Window.createOutputChannel('eXistdb Language Server');

	function didOpenTextDocument(document: TextDocument): void {
		// We are only interested in language mode text
		if (document.languageId !== 'xquery' || (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled')) {
			return;
		}

		let uri = document.uri;
		// Untitled files go to a default client.
		if (uri.scheme === 'untitled' && !defaultClient) {
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
				outputChannel: outputChannel
			};
			defaultClient = new LanguageClient('existdb-langserver', 'eXist Language Server', serverOptions, clientOptions);
			defaultClient.start();
			return;
		}
		let folder = Workspace.getWorkspaceFolder(uri);
		// Files outside a folder can't be handled. This might depend on the language.
		// Single file languages like JSON might handle files outside the workspace folders.
		if (!folder) {
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
				initializationOptions: {
					workspaceFolder: folder.uri.toString()
				}
			};
			let client = new LanguageClient('existdb-langserver', 'eXist Language Server', serverOptions, clientOptions);
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