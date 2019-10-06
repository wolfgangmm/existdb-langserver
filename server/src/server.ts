/**
 * Main entry point for the language server.
 * 
 * @author Wolfgang Meier
 */
import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind,
	TextDocument, DidChangeConfigurationNotification, TextDocumentPositionParams, CompletionItem, CompletionItemKind, NotificationType, WorkspaceFolder, ResponseError, DocumentSymbolParams, SymbolInformation, Hover
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { lintDocument } from './linting';
import { ServerSettings } from './settings';
import { AnalyzedDocument } from './analyzed-document';

const defaultSettings: ServerSettings = {
	uri: 'http://localhost:8080/exist/apps/atom-editor',
	user: 'admin',
	password: ''
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

// capabilities of the client
let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;

function getAnalyzedDocument(textDocument: TextDocument) {
	let document = analyzedDocuments.get(textDocument.uri);
	if (!document) {
		document = new AnalyzedDocument(textDocument.uri, textDocument.getText());
		analyzedDocuments.set(textDocument.uri, document);
	}
	return document;
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

function getDocumentSettings(resource: string): Thenable<ServerSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'existdb'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

connection.onInitialize((params) => {
	if (Array.isArray(params.workspaceFolders) && params.workspaceFolders.length > 0) {
		workspaceFolder = params.workspaceFolders[0];
	} else if (params.rootUri) {
		workspaceFolder = { name: '', uri: URI.file(params.rootUri).toString() };
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

	connection.console.log(`[Server ${workspaceFolder.name}] Started and initialize received`);

	// readWorkspaceConfig();

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
			hoverProvider: true
		}
	};
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

documents.onDidOpen((event) => {
	connection.console.log(`[${workspaceFolder.name}] Document opened: ${event.document.uri}`);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(async change => {
	connection.console.log(`[${workspaceFolder.name}] changed: ${change.document.uri}`);
	lint(change.document);
});

async function lint(textDocument: TextDocument) {
	const uri = textDocument.uri;
	const text = textDocument.getText();
	let document = analyzedDocuments.get(uri);
	if (!document) {
		document = new AnalyzedDocument(uri, text);
		analyzedDocuments.set(uri, document);
	} else {
		document.analyze(text);
	}
	const settings = await getDocumentSettings(uri);
	if (!settings.path) {
		settings.path = `/db/apps/${workspaceFolder.name}`;
	}
	let relPath = '/db';
	if (workspaceFolder) {
		relPath = uri.substr(workspaceFolder.uri.length + 1);
		relPath = relPath.replace(/^(.*?)\/[^\/]+$/, '$1');
	}
	const resp = await lintDocument(text, relPath, document, settings);
	if (resp instanceof ResponseError) {
		connection.console.log(`[Server ${workspaceFolder.name}] ${resp}`);
		return null;
	}
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
		document = new AnalyzedDocument(uri, text);
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
	let relPath = '/db';
	if (workspaceFolder) {
		relPath = uri.substr(workspaceFolder.uri.length + 1);
		relPath = relPath.replace(/^(.*?)\/[^\/]+$/, '$1');
	}
	const resp = await document.getCompletions(prefix, relPath, settings);
	if (resp instanceof ResponseError) {
		connection.console.log(`[Server ${workspaceFolder.name}] ${resp}`);
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

connection.onHover((params: TextDocumentPositionParams): Hover | null => {
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return null;
	}
	const document = getAnalyzedDocument(textDocument);
	return document.getHover(params.position);
});

documents.listen(connection);

connection.listen();