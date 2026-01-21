/**
 * Main entry point for the language server.
 * 
 * @author Wolfgang Meier
 */
import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, Position,
	DidChangeConfigurationNotification, TextDocumentPositionParams, CompletionItem,
	WorkspaceFolder, ResponseError, DocumentSymbolParams,
	SymbolInformation, Hover,
	Location, ConfigurationItem
} from 'vscode-languageserver/node';
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from 'vscode-uri';
import { ServerSettings } from './settings';
import { AnalyzedDocument } from './analyzed-document';
import { checkServer, installXar, readWorkspaceConfig, createWorkspaceConfig } from './utils';
import { lintDocument } from './linting';

const defaultSettings: ServerSettings = {
	uri: 'http://localhost:8080/exist',
	user: 'admin',
	password: '',
	path: ''
};

// Cache the settings of all open documents
let documentSettings: Map<string, Promise<ServerSettings>> = new Map();

// Creates the LSP connection
let connection = createConnection(ProposedFeatures.all);

// Create a manager for open text documents
let documents:TextDocuments<TextDocument> = new TextDocuments(TextDocument);
let analyzedDocuments: Map<string, AnalyzedDocument> = new Map();

const noWorkspace = 'no workspace';

// The workspace folder this server is operating on
let workspaceFolder: WorkspaceFolder;
let workspaceName: string = noWorkspace;
let workspaceConfig: ServerSettings | null = null;
let resourcesDir: string;

// capabilities of the client
let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;

function getAnalyzedDocument(textDocument: TextDocument) {
	let document = analyzedDocuments.get(textDocument.uri);
	if (!document) {
		document = new AnalyzedDocument(textDocument.uri, textDocument.getText(), log, reportStatus);
		analyzedDocuments.set(textDocument.uri, document);
	}
	return document;
}

function getRelativePath(uri: string) {
	let relPath = '/db';
	if (workspaceFolder) {
		relPath = uri.substr(workspaceFolder.uri.length + 1);
		relPath = relPath.replace(/^(.*?)\/[^\/]+$/, '$1');
	}
	return relPath;
}

export function log(message: string, prio: string = 'log') {
	switch (prio) {
		case 'warn':
			connection.console.warn(`[${workspaceName}] ${message}`);
			break;
		case 'info':
			connection.console.info(`[${workspaceName}] ${message}`);
			break;
		default:
			connection.console.log(`[${workspaceName}] ${message}`);
			break;
	}
}

connection.onDidChangeConfiguration(() => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
	}

	// Revalidate all open text documents
	documents.all().forEach(lint);
});

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
	analyzedDocuments.delete(e.document.uri);
});

function getSettings(): Promise<ServerSettings> {
	if (workspaceConfig) {
		return Promise.resolve(workspaceConfig);
	}
	const configItem: ConfigurationItem = {
		section: 'existdb'
	};
	if (workspaceFolder) {
		configItem.scopeUri = workspaceFolder.uri;
	}
	const editorSettings = connection.workspace.getConfiguration(configItem);
	if (editorSettings) {
		return Promise.resolve(editorSettings);
	}
	return Promise.resolve(defaultSettings);
}

connection.onInitialize((params) => {
	const workspaceUri = params.initializationOptions ? params.initializationOptions.workspaceFolder : null;
	if (workspaceUri) {
		if (Array.isArray(params.workspaceFolders) && params.workspaceFolders.length > 0) {
			for (let folder of params.workspaceFolders) {
				if (folder.uri === workspaceUri) {
					workspaceFolder = folder;
					workspaceName = workspaceFolder.name;
					workspaceConfig = readWorkspaceConfig(folder);
				}
			}
		} else if (params.rootUri) {
			workspaceFolder = { name: 'unnamed', uri: URI.file(params.rootUri).toString() };
			if (params.rootUri === workspaceUri) {
				workspaceConfig = readWorkspaceConfig(workspaceFolder);
				workspaceName = workspaceFolder.name;
			}
		}
	}
	resourcesDir = params.initializationOptions.resources;

	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);

	connection.console.log(`[${workspaceName}] Started and initialized.`);

	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Incremental
			},
			completionProvider: {
				resolveProvider: true
			},
			documentSymbolProvider: true,
			definitionProvider: true,
			hoverProvider: true
		}
	};
});

async function checkServerConnection() {
	if (resourcesDir) {
		const settings = await getSettings();
		log(`Checking connection to ${settings.uri}`);
		reportStatus('Connecting ...', settings);
		checkServer(settings, resourcesDir).then(response => {
			if (response) {
				log(`Sending existdb/install notification ${response.xar.path}`);
				connection.sendNotification('existdb/install', [response.message, response.xar]);
			}
			if (workspaceName !== noWorkspace) {
				log(`Connection ok`);
				reportStatus(workspaceName, settings);
			}
		},
		(message) => {
			log(`Connection failed: ${message}`);
			connection.window.showWarningMessage(`Connection failed: ${message}`);
			connection.sendNotification('existdb/status', ['$(database) Disconnected', settings.uri]);
		});
	}
}

async function reportStatus(online: boolean | string, settings: ServerSettings | undefined) {
	if (!settings) {
		settings = await getSettings();
	}
	let message;
	if (typeof online === 'string') {
		message = online;
	} else {
		message = online ? workspaceName : 'Disconnected';
	}
	connection.sendNotification('existdb/status', [`$(database) ${message}`, settings.uri]);
}

async function deployXar(args: any[] | undefined) {
	if (!args) {
		log('No arguments provided for deployXar');
		return;
	}
	const [xar] = args;
	const settings = await getSettings();
	log(`Installing server-side XAR ${xar.path} on ${settings.uri}`);
	return new Promise((resolve, reject) => {
		installXar(settings, xar).then(
			(success) => {
				if (!success) {
					connection.window.showWarningMessage('Installing XAR failed!');
					reject();
				} else {
					connection.window.showInformationMessage('XAR installed.');
					resolve(null);
				}
			},
			(error) => {
				log(`Connecting to server failed: ${error}`);
				connection.window.showWarningMessage(`Connecting to server failed: ${error}`);
				reject();
			}
		);
	});
}

connection.onInitialized(async () => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability && workspaceFolder) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}

	checkServerConnection();
});

documents.onDidOpen((event) => {
	connection.console.log(`[${workspaceName}] Document opened: ${event.document.uri}`);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(async change => {
	connection.console.log(`[${workspaceName}] changed: ${change.document.uri}`);
	lint(change.document);
});

connection.onExecuteCommand(params => {
	log(`Executing command ${params.command}`);
	switch (params.command) {
		case 'createConfig':
			return createWorkspaceConfig(workspaceFolder);
		case 'reconnect':
			if (workspaceFolder) {
				workspaceConfig = readWorkspaceConfig(workspaceFolder);
			}
			return checkServerConnection();
		case 'deploy':
			return deployXar(params.arguments);
		case 'execute':
			return executeQuery(params.arguments);
	}
});

async function executeQuery(args: any[] | undefined): Promise<any> {
	if (args) {
		const [uri, text] = args;
		const settings = await getSettings();
		let document = analyzedDocuments.get(uri);
		if (!document) {
			document = new AnalyzedDocument(uri, text, log, reportStatus);
			analyzedDocuments.set(uri, document);
		}
		const relPath = getRelativePath(uri.toString());
		return document.executeQuery(text, settings, relPath);
	}
	return [];
}

async function lint(textDocument: TextDocument) {
	const uri = textDocument.uri;
	const text = textDocument.getText();
	let document = analyzedDocuments.get(uri);
	if (!document) {
		document = new AnalyzedDocument(uri, text, log, reportStatus);
		analyzedDocuments.set(uri, document);
	} else {
		document.analyze(text);
	}
	const settings = await getSettings();
	if (!settings.path) {
		settings.path = workspaceFolder ? `/db/apps/${workspaceName}` : '/db';
	}
	const relPath = getRelativePath(uri);
	const resp = await lintDocument(text, relPath, document, settings);
	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: uri, diagnostics: document.diagnostics });
}

connection.onCompletion(autocomplete);

async function autocomplete(position: TextDocumentPositionParams): Promise<CompletionItem[]> {
	const uri = position.textDocument.uri;
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return [];
	}
	const text = textDocument.getText();
	let document = analyzedDocuments.get(uri);
	if (!document) {
		document = new AnalyzedDocument(uri, text, log, reportStatus);
		analyzedDocuments.set(uri, document);
	}
	const settings = await getSettings();
	const offset = textDocument.offsetAt(position.position);
	let start = offset;
	for (let i = offset - 1; i > 0; i--) {
		const code = text.charCodeAt(i);
		if ((code > 47 && code < 58) || // numeric (0-9)
			(code > 64 && code < 91) || // upper alpha (A-Z)
			(code > 96 && code < 123) || // lower alpha (a-z)
			(code === 58) ||
			(code === 36)) {
			--start;
		} else {
			break;
		}
	}
	const prefix = text.substring(start, offset);
	const relPath = getRelativePath(uri);
	const resp = await document.getCompletions(prefix, relPath, settings);
	if (resp instanceof ResponseError) {
		connection.console.log(`[${workspaceName}] ${resp}`);
	} else {
		return resp;
	}

	return [];
}

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	return item;
});

connection.onDocumentSymbol((params: DocumentSymbolParams): SymbolInformation[] => {
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return [];
	}
	const document = getAnalyzedDocument(textDocument);
	return document.getDocumentSymbols(textDocument);
});

connection.onHover((params: TextDocumentPositionParams): Promise<Hover | null> => {
	return hover(params.textDocument.uri, params.position);
});

async function hover(uri: string, position: Position) {
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return null;
	}
	const document = getAnalyzedDocument(textDocument);
	const relPath = getRelativePath(uri);
	const settings = await getSettings();
	return document.getHover(position, relPath, settings);
}

connection.onDefinition((params: TextDocumentPositionParams): Promise<Location | null> => {
	return gotoDefinition(params.textDocument.uri, params.position);
});

async function gotoDefinition(uri: string, position: Position) {
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return null;
	}
	const document = getAnalyzedDocument(textDocument);
	const relPath = getRelativePath(uri);
	const settings = await getSettings();
	return document.gotoDefinition(position, relPath, textDocument, settings);
}

connection.onDidChangeWatchedFiles(() => {
	log(`Reloading workspace config`);
	if (workspaceFolder) {
		workspaceConfig = readWorkspaceConfig(workspaceFolder);
	}
	return checkServerConnection();
});

documents.listen(connection);

// connection.sendNotification('window/showMessage', { type: MessageType.Info, message: 'Hello' });

connection.listen();
