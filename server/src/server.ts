/**
 * Main entry point for the language server.
 * 
 * @author Wolfgang Meier
 */
import {
	createConnection, TextDocuments, ProposedFeatures, TextDocumentSyncKind, Position,
	DidChangeConfigurationNotification, TextDocumentPositionParams, CompletionItem,
	WorkspaceFolder, ResponseError, DocumentSymbolParams,
	SymbolInformation, SymbolKind, Hover,
	Location, ConfigurationItem, ReferenceParams,
	DocumentFormattingParams, TextEdit, Range,
	SemanticTokensParams, SemanticTokensBuilder, SemanticTokensLegend,
	SemanticTokenTypes, SemanticTokenModifiers,
	SignatureHelp, SignatureHelpParams, RenameParams, WorkspaceEdit
} from 'vscode-languageserver/node';
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from 'vscode-uri';
import { ServerSettings } from './settings';
import { AnalyzedDocument } from './analyzed-document';
import { checkServer, installXar, readWorkspaceConfig, createWorkspaceConfig } from './utils';
import { lintDocument } from './linting';
import axios from 'axios';

// Semantic token types used by XQuery highlighting
const tokenTypes = [
	SemanticTokenTypes.function,
	SemanticTokenTypes.variable,
	SemanticTokenTypes.namespace,
	SemanticTokenTypes.decorator,  // annotations
	SemanticTokenTypes.type,
	SemanticTokenTypes.parameter
];
const tokenModifiers = [
	SemanticTokenModifiers.declaration,
	SemanticTokenModifiers.definition
];
const semanticTokensLegend: SemanticTokensLegend = {
	tokenTypes: tokenTypes,
	tokenModifiers: tokenModifiers
};

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
let hasLspEval: boolean = false;

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
			hoverProvider: true,
			referencesProvider: true,
			documentFormattingProvider: true,
			signatureHelpProvider: {
				triggerCharacters: ['(', ',']
			},
			renameProvider: true,
			semanticTokensProvider: {
				legend: semanticTokensLegend,
				full: true
			}
		}
	};
});

async function checkLspEvalCapability(settings: ServerSettings): Promise<boolean> {
	// Read the capabilities endpoint introduced in existdb-openapi#17. The
	// previous probe-hack (sending a dummy query and inspecting the response
	// for a cursor field) is no longer needed.
	try {
		const response = await axios.get(`${settings.uri}/apps/existdb-openapi/api/langservice/capabilities`, {
			auth: { username: settings.user, password: settings.password },
			responseType: 'json'
		});
		if (response.status === 200 && response.data && response.data.cursor) {
			return response.data.cursor.available === true;
		}
	} catch (_) {
		// endpoint not available; legacy execution path will be used
	}
	return false;
}

async function checkExistApiAvailable(settings: ServerSettings): Promise<boolean> {
	try {
		const response = await axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/diagnostics`, {
			expression: '1'
		}, {
			auth: { username: settings.user, password: settings.password },
			headers: { "Content-Type": "application/json" },
			responseType: 'json'
		});
		return response.status === 200;
	} catch (_) {
		return false;
	}
}

async function checkServerConnection() {
	if (resourcesDir) {
		const settings = await getSettings();
		log(`Checking connection to ${settings.uri}`);
		reportStatus('Connecting ...', settings);

		// Check if existdb-openapi provides langservice endpoints — if so, skip the
		// atom-editor helper XAR prompt since existdb-openapi supersedes it
		const hasExistApi = await checkExistApiAvailable(settings);
		if (hasExistApi) {
			log('existdb-openapi langservice endpoints available, skipping helper XAR check');
			if (workspaceName !== noWorkspace) {
				log(`Connection ok`);
				reportStatus(workspaceName, settings);
			}
			hasLspEval = await checkLspEvalCapability(settings);
			log(`cursor:eval capability: ${hasLspEval ? 'available' : 'not available, using legacy execution'}`);
			return;
		}

		checkServer(settings, resourcesDir).then(async response => {
			if (response) {
				log(`Sending existdb/install notification ${response.xar.path}`);
				connection.sendNotification('existdb/install', [response.message, response.xar]);
			}
			if (workspaceName !== noWorkspace) {
				log(`Connection ok`);
				reportStatus(workspaceName, settings);
			}
			// Check if cursor-based execution is available
			hasLspEval = await checkLspEvalCapability(settings);
			log(`cursor:eval capability: ${hasLspEval ? 'available' : 'not available, using legacy execution'}`);
		},
		(message) => {
			log(`Connection failed: ${message}`);
			hasLspEval = false;
			connection.window.showWarningMessage(`Connection failed: ${message}`);
			connection.sendNotification('existdb/status', ['$(database) Disonnected', settings.uri]);
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
		case 'fetch':
			return fetchResults(params.arguments);
		case 'closeCursor':
			return closeCursor(params.arguments);
	}
});

async function executeQuery(args: any[] | undefined): Promise<any> {
	if (args) {
		const [uri, text, serializationOptions] = args;
		const settings = await getSettings();
		let document = analyzedDocuments.get(uri);
		if (!document) {
			document = new AnalyzedDocument(uri, text, log, reportStatus);
			analyzedDocuments.set(uri, document);
		}
		const relPath = getRelativePath(uri.toString());
		if (hasLspEval) {
			return document.evalQuery(text, settings, relPath, 100, serializationOptions);
		}
		return document.executeQuery(text, settings, relPath);
	}
	return [];
}

async function fetchResults(args: any[] | undefined): Promise<any> {
	if (args) {
		const [cursor, start, count, serializationOptions] = args;
		const settings = await getSettings();
		// Use a temporary AnalyzedDocument for the REST call
		const doc = new AnalyzedDocument('fetch', null, log, reportStatus);
		return doc.fetchResults(cursor, start, count, settings, serializationOptions);
	}
	return [];
}

async function closeCursor(args: any[] | undefined): Promise<boolean> {
	if (args) {
		const [cursor] = args;
		const settings = await getSettings();
		const doc = new AnalyzedDocument('close', null, log, reportStatus);
		return doc.closeCursor(cursor, settings);
	}
	return false;
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
	const resp = await document.getCompletions(text, prefix, relPath, settings);
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

connection.onDocumentSymbol(async (params: DocumentSymbolParams): Promise<SymbolInformation[]> => {
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return [];
	}
	const document = getAnalyzedDocument(textDocument);
	const settings = await getSettings();
	const relPath = getRelativePath(uri);

	// Try server-side symbols for richer results (return types, parameter types)
	try {
		const response = await axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/symbols`, {
			query: textDocument.getText(),
			"module-load-path": `${settings.path}/${relPath}`
		}, {
			auth: { username: settings.user, password: settings.password },
			headers: { "Content-Type": "application/json" },
			responseType: 'json'
		});

		if (response.status === 200 && Array.isArray(response.data) && response.data.length > 0) {
			return response.data.map((sym: any) => ({
				name: sym.detail || sym.name,
				kind: sym.kind === 12 ? SymbolKind.Function : SymbolKind.Variable,
				location: {
					uri,
					range: Range.create(sym.line || 0, sym.column || 0, sym.line || 0, sym.column || 0)
				}
			}));
		}
	} catch (e) {
		// Fall through to local symbols
	}

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
	return document.getHover(position, relPath, textDocument, settings);
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

// --- Find References ---
connection.onReferences(async (params: ReferenceParams): Promise<Location[]> => {
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return [];
	}
	const settings = await getSettings();
	const relPath = getRelativePath(uri);

	try {
		const response = await axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/references`, {
			query: textDocument.getText(),
			line: params.position.line + 1,
			column: params.position.character + 1,
			"module-load-path": `${settings.path}/${relPath}`
		}, {
			auth: { username: settings.user, password: settings.password },
			headers: { "Content-Type": "application/json" },
			responseType: 'json'
		});

		if (response.status === 200 && Array.isArray(response.data)) {
			return response.data.map((ref: any) => ({
				uri,
				range: Range.create(
					Math.max(ref.line - 1, 0),
					Math.max((ref.column || 1) - 1, 0),
					Math.max(ref.line - 1, 0),
					Math.max((ref.column || 1) - 1, 0)
				)
			}));
		}
	} catch (e) {
		// Server doesn't support references yet
	}
	return [];
});

// --- Signature Help ---
connection.onSignatureHelp(async (params: SignatureHelpParams): Promise<SignatureHelp | null> => {
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return null;
	}
	const settings = await getSettings();
	const relPath = getRelativePath(uri);

	try {
		const response = await axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/signatureHelp`, {
			expression: textDocument.getText(),
			line: params.position.line,
			column: params.position.character,
			"module-load-path": `${settings.path}/${relPath}`
		}, {
			auth: { username: settings.user, password: settings.password },
			headers: { "Content-Type": "application/json" },
			responseType: 'json'
		});

		if (response.status === 200 && response.data?.signatures) {
			return {
				signatures: response.data.signatures.map((sig: any) => ({
					label: sig.label,
					documentation: sig.documentation,
					parameters: sig.parameters?.map((p: any) => ({
						label: p.label,
						documentation: p.documentation
					}))
				})),
				activeSignature: response.data.activeSignature || 0,
				activeParameter: response.data.activeParameter || 0
			};
		}
	} catch (e) {
		// Server doesn't support signature help yet
	}
	return null;
});

// --- Rename Symbol ---
connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | null> => {
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return null;
	}
	const settings = await getSettings();
	const relPath = getRelativePath(uri);

	try {
		const response = await axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/rename`, {
			expression: textDocument.getText(),
			line: params.position.line,
			column: params.position.character,
			newName: params.newName,
			"module-load-path": `${settings.path}/${relPath}`
		}, {
			auth: { username: settings.user, password: settings.password },
			headers: { "Content-Type": "application/json" },
			responseType: 'json'
		});

		if (response.status === 200 && response.data?.changes && Array.isArray(response.data.changes)) {
			const changes: { [uri: string]: TextEdit[] } = {};
			changes[uri] = response.data.changes.map((edit: any) => {
				// existdb-openapi returns 0-based line but 1-based column
				const startLine = edit.line;
				const startCol = Math.max(edit.column - 1, 0);
				const endCol = Math.max(edit.endColumn - 1, 0);
				return {
					range: Range.create(startLine, startCol, startLine, endCol),
					newText: edit.newText
				};
			});
			return { changes };
		}
	} catch (e) {
		// Server doesn't support rename yet
	}
	return null;
});

// --- Semantic Tokens ---
connection.languages.semanticTokens.on(async (params: SemanticTokensParams) => {
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return { data: [] };
	}
	const settings = await getSettings();
	const relPath = getRelativePath(uri);
	const text = textDocument.getText();
	const builder = new SemanticTokensBuilder();

	try {
		const response = await axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/symbols`, {
			query: text,
			"module-load-path": `${settings.path}/${relPath}`
		}, {
			auth: { username: settings.user, password: settings.password },
			headers: { "Content-Type": "application/json" },
			responseType: 'json'
		});

		if (response.status === 200 && Array.isArray(response.data)) {
			for (const symbol of response.data) {
				// lang:symbols returns 0-indexed line/column
				const line = symbol.line || 0;
				const col = symbol.column || 0;
				const name = (symbol.name || '').replace(/#\d+$/, '');
				const length = name.length;
				// Map symbol kind to semantic token type
				const kind = symbol.kind;
				let tokenType = 0; // function
				if (kind === 6 || kind === 13) { // Variable or Property
					tokenType = 1; // variable
				}
				builder.push(line, col, length, tokenType, 1); // modifier: declaration
			}
		}
	} catch (e) {
		// Fall back to local symbols
		const document = getAnalyzedDocument(textDocument);
		const symbols = document.getDocumentSymbols(textDocument);
		for (const sym of symbols) {
			const line = sym.location.range.start.line;
			const col = sym.location.range.start.character;
			const name = sym.name.replace(/\(.*$/, '');
			const length = name.length;
			const tokenType = sym.kind === SymbolKind.Function ? 0 : 1;
			builder.push(line, col, length, tokenType, 1);
		}
	}

	return builder.build();
});

// --- Document Formatting (XQuery only) ---
connection.onDocumentFormatting(async (params: DocumentFormattingParams): Promise<TextEdit[]> => {
	const uri = params.textDocument.uri;
	const textDocument = documents.get(uri);
	if (!textDocument) {
		return [];
	}

	// Only format XQuery files — VS Code handles other languages natively
	const ext = uri.replace(/^.*\./, '').toLowerCase();
	if (!['xq', 'xql', 'xqm', 'xquery', 'xqy'].includes(ext)) {
		return [];
	}

	const text = textDocument.getText();
	try {
		const prettier = require('prettier');
		const xqPlugin = require('prettier-plugin-xquery');

		const formatted = await prettier.format(text, {
			parser: 'xquery',
			plugins: [xqPlugin],
			tabWidth: params.options.tabSize,
			useTabs: !params.options.insertSpaces
		});

		const lastLine = textDocument.lineCount - 1;
		const lastChar = textDocument.getText().length;
		return [{
			range: Range.create(0, 0, lastLine, lastChar),
			newText: formatted
		}];
	} catch (e) {
		log(`XQuery formatting failed: ${e}`, 'error');
		return [];
	}
});

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