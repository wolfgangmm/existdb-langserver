/**
 * Main entry point for the language server.
 * 
 * @author Wolfgang Meier
 */
import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, Position,
	TextDocument, DidChangeConfigurationNotification, TextDocumentPositionParams, CompletionItem,
	WorkspaceFolder, ResponseError, DocumentSymbolParams,
	SymbolInformation, Hover,
	Location, InitializeResult
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { lintDocument } from './linting';
import { ServerSettings } from './settings';
import { AnalyzedDocument } from './analyzed-document';
import * as path from 'path';
import * as fs from 'fs';

const defaultSettings: ServerSettings = {
	uri: 'http://localhost:8080/exist/apps/atom-editor',
	user: 'admin',
	password: '',
	path: ''
};
let globalSettings: ServerSettings = defaultSettings;

// Cache the settings of all open documents
let documentSettings: Map<string, Thenable<ServerSettings>> = new Map();

// Creates the LSP connection
let connection = createConnection(ProposedFeatures.all);

// Create a manager for open text documents
let documents = new TextDocuments();
let analyzedDocuments: Map<string, AnalyzedDocument> = new Map();

// The workspace folder this server is operating on
let workspaceFolder: WorkspaceFolder;
let workspaceName: string = 'no workspace';
let workspaceConfig: ServerSettings | null = null;

// capabilities of the client
let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;

function getAnalyzedDocument(textDocument: TextDocument) {
	let document = analyzedDocuments.get(textDocument.uri);
	if (!document) {
		document = new AnalyzedDocument(textDocument.uri, textDocument.getText(), log);
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

function log(message: string, prio: string = 'log') {
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

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ServerSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// Revalidate all open text documents
	documents.all().forEach(lint);
});

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
	analyzedDocuments.delete(e.document.uri);
});

function readWorkspaceConfig(workspaceFolder: WorkspaceFolder): ServerSettings | null {
	const uri = URI.parse(workspaceFolder.uri);
	const config = path.join(uri.fsPath, '.existdb.json');
	if (!fs.existsSync(config)) {
		return null;
	}
	const configData = fs.readFileSync(config, 'utf8');
	const json = JSON.parse(configData);
	const sync = json.sync;
	if (!sync) {
		return null;
	}

	const serverDef = sync.server;
	if (!serverDef) {
		return null;
	}
	const server = json.servers[serverDef];
	if (!server) {
		return null;
	}
	const user = sync.user || server.user;
	const password = sync.password || server.password;
	const settings: ServerSettings = {
		uri: server.server,
		user: user,
		password: password,
		path: sync.root
	};
	return settings;
}

function getDocumentSettings(resource: string): Thenable<ServerSettings> {
	if (workspaceConfig) {
		return Promise.resolve(workspaceConfig);
	}
	if (workspaceFolder) {
		const editorSettings = connection.workspace.getConfiguration({
			scopeUri: workspaceFolder.uri,
			section: 'existdb'
		});
		if (editorSettings) {
			return Promise.resolve(editorSettings);
		}
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
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we will fall back using global settings
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);

	connection.console.log(`[${workspaceName}] Started and initialized`);

	return {
		capabilities: {
			textDocumentSync: {
				openClose: true,
				change: TextDocumentSyncKind.Full
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

async function lint(textDocument: TextDocument) {
	const uri = textDocument.uri;
	const text = textDocument.getText();
	let document = analyzedDocuments.get(uri);
	if (!document) {
		document = new AnalyzedDocument(uri, text, log);
		analyzedDocuments.set(uri, document);
	} else {
		document.analyze(text);
	}
	const settings = await getDocumentSettings(uri);
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
		document = new AnalyzedDocument(uri, text, log);
		analyzedDocuments.set(uri, document);
	}
	const settings = await getDocumentSettings(uri);
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
		connection.console.log(`[Server ${workspaceName}] ${resp}`);
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
	const settings = await getDocumentSettings(uri);
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
	const settings = await getDocumentSettings(uri);
	return document.gotoDefinition(position, relPath, textDocument, settings);
}

documents.listen(connection);

// connection.sendNotification('window/showMessage', { type: MessageType.Info, message: 'Hello' });

connection.listen();