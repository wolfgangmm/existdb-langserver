import { Diagnostic, CompletionItem, CompletionItemKind, InsertTextFormat, ResponseError, ErrorCodes, SymbolInformation, TextDocument, Range, Position, Hover, MarkupKind, Location } from 'vscode-languageserver';
import { ServerSettings } from './settings';
import { AST } from './ast';
import axios from 'axios';
import * as path from 'path';
import { URI } from 'vscode-uri';

const funcDefRe = /(?:\(:~(.*?):\))?\s*declare\s+((?:%[\w\:\-]+(?:\([^\)]*\))?\s*)*function\s+([^\(]+)\()/gsm;
const trimRe = /^[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+|[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const paramRe = /\$[^\s]+/;

interface Symbol {
	signature: string;
	type: string;
	name: string;
	snippet: string;
	documentation?: string;
	arguments?: [{
		name: string,
		type: string,
		description?: string
	}];
	location?: {
		start: number;
		end: number;
	};
}

/**
 * Holds analysis information about an open document, including diagnostics, local symbols etc.
 *
 * @author Wolfgang Meier
 */
export class AnalyzedDocument {

	uri: string;

	diagnostics: Diagnostic[] = [];

	localSymbols: Symbol[] = [];

	symbolsMap: Map<string, Symbol> = new Map();

	ast: any;

	logger: (message: string, prio?: string) => void;

	status: (message: boolean | string, settings?: ServerSettings) => void;

	constructor(uri: string, text: string | null = null, logger: (message: string, prio?: string) => void,
		status: (message: boolean | string, settings?: ServerSettings) => void) {
		this.uri = uri;
		this.logger = logger;
		this.status = status;
		if (text) {
			this.analyze(text);
		}
	}

	analyze(text: string) {
		this.symbolsMap.clear();
		AnalyzedDocument.getLocalSymbols(text, false, this.symbolsMap);
		this.localSymbols = Array.from(this.symbolsMap.values());
	}

	async gotoDefinition(position: Position, relPath: string, textDocument: TextDocument, settings: ServerSettings): Promise<Location | null> {
		if (!this.ast) {
			return null;
		}
		// Try local symbol lookup first (no roundtrip)
		const signature = this.getSignatureFromPosition(position);
		if (signature) {
			const symbol = this.symbolsMap.get(`${signature.name}#${signature.arity}`);
			if (symbol && symbol.location) {
				return {
					uri: this.uri,
					range: this.computeLocation(textDocument, symbol.location)
				};
			}
			// Fall back to server-side definition
			return this.gotoDefinitionRemote(textDocument, position, relPath, settings);
		}
		return null;
	}

	private async gotoDefinitionRemote(textDocument: TextDocument, position: Position, relPath: string, settings: ServerSettings): Promise<Location | null> {
		try {
			// lang:* / cursor:* expects 1-indexed line/column
			const response = await axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/definition`, {
				query: textDocument.getText(),
				line: position.line + 1,
				column: position.character + 1,
				"module-load-path": `${settings.path}/${relPath}`
			}, {
				auth: {
					username: settings.user,
					password: settings.password
				},
				headers: { "Content-Type": "application/json" },
				responseType: 'json'
			});

			if (response.status !== 200) {
				this.status(false, settings);
				return null;
			}

			this.status(true, settings);
			const def = response.data;
			if (!def || !def.line && def.line !== 0) {
				return null;
			}

			// lang:* / cursor:* returns 1-indexed; convert to 0-indexed for LSP protocol
			const defLine = Math.max(def.line - 1, 0);
			const defCol = Math.max((def.column || 1) - 1, 0);

			// Cross-module: map database path to workspace file URI
			let targetUri = this.uri;
			if (def.uri && settings.path) {
				const dbPath: string = def.uri;
				const dbRoot: string = settings.path;
				if (dbPath.startsWith(dbRoot)) {
					const relModulePath = dbPath.substring(dbRoot.length);
					const currentFilePath = URI.parse(this.uri).fsPath;
					const workspaceRoot = currentFilePath.substring(0,
						currentFilePath.length - relPath.length - path.basename(currentFilePath).length);
					const targetPath = path.join(workspaceRoot, relModulePath);
					targetUri = URI.file(targetPath).toString();
				}
			}

			return {
				uri: targetUri,
				range: Range.create(defLine, defCol, defLine, defCol)
			};
		} catch (error) {
			this.status(false, settings);
			return null;
		}
	}

	async getHover(position: Position, relPath: string, textDocument: TextDocument, settings: ServerSettings): Promise<Hover | null> {
		if (!this.ast) {
			return null;
		}
		// Try local symbol lookup first (no roundtrip)
		const signature = this.getSignatureFromPosition(position);
		if (signature) {
			const symbol = this.symbolsMap.get(`${signature.name}#${signature.arity}`);
			if (symbol) {
				const md = [`**${symbol.signature}**`];
				if (symbol.documentation) {
					md.push(symbol.documentation);
				}
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: md.join('\n\n')
					}
				};
			}
			// Fall back to server-side hover
			return this.getHoverRemote(textDocument, position, relPath, settings);
		}
		return null;
	}

	private async getHoverRemote(textDocument: TextDocument, position: Position, relPath: string, settings: ServerSettings): Promise<Hover | null> {
		try {
			// lang:* / cursor:* expects 1-indexed line/column
			const response = await axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/hover`, {
				query: textDocument.getText(),
				line: position.line + 1,
				column: position.character + 1,
				"module-load-path": `${settings.path}/${relPath}`
			}, {
				auth: {
					username: settings.user,
					password: settings.password
				},
				headers: { "Content-Type": "application/json" },
				responseType: 'json'
			});

			if (response.status !== 200) {
				this.status(false, settings);
				return null;
			}

			this.status(true, settings);
			const hover = response.data;
			if (!hover || !hover.contents) {
				return null;
			}

			return {
				contents: {
					kind: MarkupKind.Markdown,
					value: hover.contents
				}
			};
		} catch (error) {
			this.status(false, settings);
			return null;
		}
	}

	getCompletions(text: string, prefix: string | null, relPath: string, settings: ServerSettings): Promise<CompletionItem[] | ResponseError<any>> {
		const body: any = {
			query: text,
			"module-load-path": `${settings.path}/${relPath}`
		};
		if (prefix) {
			body.prefix = prefix;
		}
		return axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/completions`, body, {
			auth: {
				username: settings.user,
				password: settings.password
			},
			headers: { "Content-Type": "application/json" },
			responseType: 'json'
		}).then(response => {
			if (response.status !== 200) {
				this.status(false, settings);
				throw new Error(`Unexpected status code: ${response.status}`);
			}
			this.status(true, settings);
			const items: any[] = response.data;
			const remoteCompletions = items.map((item: any) => {
				const symbol: Symbol = {
					signature: item.detail || item.label,
					type: item.kind === 'function' ? 'function' : 'variable',
					snippet: item.insertText || item.label,
					name: item.label,
					documentation: item.documentation
				};
				this.symbolsMap.set(symbol.name, symbol);
				return symbol;
			});
			return this.mapCompletions(this.localSymbols).concat(this.mapCompletions(remoteCompletions));
		}).catch(error => {
			this.status(false, settings);
			return new ResponseError(ErrorCodes.InvalidRequest, error);
		});
	}

	getDocumentSymbols(textDocument: TextDocument): SymbolInformation[] {
		return this.mapDocumentSymbols(this.localSymbols, textDocument);
	}

	/**
	 * Cursor-based query execution via cursor:eval().
	 * Returns a cursor handle, total item count, elapsed time, and the first page of results.
	 */
	async evalQuery(query: string, settings: ServerSettings, relPath: string, pageSize: number = 100, serializationOptions?: Record<string, string>): Promise<any> {
		const output = this.getOutputMode(query);
		const moduleLoadPath = `${settings.path}/${relPath}`;
		this.logger(`Eval query with output mode: ${output}, path: ${moduleLoadPath}`);
		// POST /api/query — server-side maps to cursor:eval and returns { cursor, items, elapsed }
		const response = await axios.post(`${settings.uri}/apps/existdb-openapi/api/query`, {
			query,
			"module-load-path": moduleLoadPath
		}, {
			auth: { username: settings.user, password: settings.password },
			headers: { "Content-Type": "application/json" },
			responseType: 'json'
		});
		const { cursor, items, elapsed } = response.data;
		// Fetch first page immediately with serialization options
		const results = await this.fetchResults(cursor, 1, pageSize, settings, serializationOptions);
		return {
			output,
			cursor,
			hits: items,
			elapsed,
			results
		};
	}

	/**
	 * Fetch a page of results from an open cursor via cursor:fetch().
	 * Serialization options (method, indent, highlight-matches) are forwarded to the server.
	 */
	async fetchResults(cursor: string, start: number, count: number, settings: ServerSettings, serializationOptions?: Record<string, string>): Promise<any[]> {
		// GET /api/query/{id}/results — server-side maps to cursor:fetch
		const params: Record<string, string> = { start: String(start), count: String(count) };
		if (serializationOptions) {
			Object.assign(params, serializationOptions);
		}
		const response = await axios.get(`${settings.uri}/apps/existdb-openapi/api/query/${encodeURIComponent(cursor)}/results`, {
			params,
			auth: { username: settings.user, password: settings.password },
			responseType: 'json'
		});
		return response.data;
	}

	/**
	 * Close a server-side cursor via cursor:close().
	 */
	async closeCursor(cursor: string, settings: ServerSettings): Promise<boolean> {
		// DELETE /api/query/{id} — server-side maps to cursor:close
		const response = await axios.delete(`${settings.uri}/apps/existdb-openapi/api/query/${encodeURIComponent(cursor)}`, {
			auth: { username: settings.user, password: settings.password },
			responseType: 'json'
		});
		return response.data?.closed === true;
	}

	/**
	 * Legacy execution path via atom-editor endpoint.
	 * Used as fallback when cursor:eval is not available.
	 */
	executeQuery(query: string, settings: ServerSettings, relPath: string): Promise<any> {
		const params = {
			output: this.getOutputMode(query),
			qu: query,
			count: '100',
			base: `${settings.path}/${relPath}`
		};
		this.logger(`Execute query (legacy) with output mode: ${params.output}, path: ${params.base}`);
		return axios.post(`${settings.uri}/apps/atom-editor/execute`, new URLSearchParams(params).toString(), {
			auth: {
				username: settings.user,
				password: settings.password
			},
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			responseType: 'text'
		}).then(response => {
			const resultCount = response.headers['x-result-count'];
			const queryTime = response.headers['x-elapsed'];
			const queryResponse = {
				output: params.output,
				hits: resultCount,
				elapsed: queryTime,
				results: response.data
			};
			return queryResponse;
		}).catch(error => {
			throw error;
		});
	}

	private getOutputMode(content: string) {
		const match = /declare\s+option.*:method\s+"(.*)"\s*;/.exec(content);
		if (match) {
			return match[1];
		}
		return 'adaptive';
	}

	private mapCompletions(symbols: any[]): CompletionItem[] {
		return symbols.map(symbol => {
			const completion: CompletionItem = {
				label: symbol.signature,
				kind: symbol.type === 'function' ? CompletionItemKind.Function : CompletionItemKind.Variable,
				data: symbol.name,
				insertText: symbol.snippet,
				insertTextFormat: InsertTextFormat.Snippet
			};
			if (symbol.documentation) {
				completion.detail = symbol.name;
				completion.documentation = symbol.documentation;
			}
			return completion;
		});
	}

	private mapDocumentSymbols(symbols: any[], textDocument: TextDocument): SymbolInformation[] {
		return symbols.map(symbol => {
			return {
				name: symbol.signature,
				kind: symbol.type === 'function' ? CompletionItemKind.Function : CompletionItemKind.Variable,
				location: {
					uri: this.uri,
					range: this.computeLocation(textDocument, symbol.location)
				}
			};
		});
	}

	private computeLocation(textDocument: TextDocument, offsets: { start: number; end: number; }): Range {
		return {
			start: textDocument.positionAt(offsets.start),
			end: textDocument.positionAt(offsets.end)
		};
	}

	private static getLocalSymbols(text: string, lineCount: boolean, map: Map<string, Symbol> = new Map()): Map<string, Symbol> {
		let funcDef = funcDefRe.exec(text);
		while (funcDef) {
			if (funcDef[2]) {
				const offset = funcDefRe.lastIndex;
				const end = AnalyzedDocument.findMatchingParen(text, offset);

				const documentation = funcDef[1];
				const name = funcDef[3].replace(trimRe, "");
				const argsStr = text.substring(offset, end);
				let args: string[] = [];
				if (argsStr.indexOf(',') > -1) {
					args = argsStr.split(/\s*,\s*/);
				} else if (argsStr !== '') {
					args = [argsStr];
				}
				const arity = args.length;
				const signature = name + "(" + args + ")";
				let location;
				if (lineCount) {
					const line = AnalyzedDocument.getLine(text, offset);
					location = {
						start: line,
						end: line
					};
				} else {
					location = {
						start: offset,
						end: end
					};
				}
				const symbol: Symbol = {
					signature: signature,
					type: 'function',
					name: `${name}#${arity}`,
					snippet: AnalyzedDocument.getSnippet(name, args),
					location: location
				};
				if (documentation) {
					symbol.documentation = documentation;
				}
				map.set(symbol.name, symbol);
			}
			funcDef = funcDefRe.exec(text);
		}
		return map;
	}

	private static getLocalSymbol(text: string, name: string, arity: number): Symbol | null {
		const re = new RegExp(`(?:\\(:~(.*?):\\))?\\s*declare\\s+((?:%[\\w\\:\\-]+(?:\\([^\\)]*\\))?\\s*)*function\\s+${name}\\()`, 'gsm');
		let funcDef = funcDefRe.exec(text);
		while (funcDef) {
			if (funcDef[2]) {
				const offset = funcDefRe.lastIndex;
				const end = AnalyzedDocument.findMatchingParen(text, offset);

				const documentation = funcDef[1];
				const fname = funcDef[3].replace(trimRe, "");
				const argsStr = text.substring(offset, end);
				let args: string[] = [];
				if (argsStr.indexOf(',') > -1) {
					args = argsStr.split(/\s*,\s*/);
				} else if (argsStr !== '') {
					args = [argsStr];
				}
				const arity = args.length;
				if (args.length === arity && fname === name) {
					const line = AnalyzedDocument.getLine(text, offset);
					const location = {
						start: line,
						end: line
					};
					const symbol: Symbol = {
						signature: name + "(" + args + ")",
						type: 'function',
						name: `${name}#${arity}`,
						snippet: AnalyzedDocument.getSnippet(name, args),
						location: location
					};
					if (documentation) {
						symbol.documentation = documentation;
					}
					return symbol;
				}
			}
			funcDef = funcDefRe.exec(text);
		}
		return null;
	}

	private static findMatchingParen(text: string, offset: number) {
		let depth = 1;
		for (let i = offset; i < text.length; i++) {
			let ch = text.charAt(i);
			if (ch === ')') {
				depth -= 1;
				if (depth === 0) {
					return i;
				}
			} else if (ch === '(') {
				depth += 1;
			}
		}
		return -1;
	}

	private static getSnippet(name: string, args: string[]) {
		let templates = [];
		for (let i = 0; i < args.length; i++) {
			const param = paramRe.exec(args[i]);
			if (param) {
				templates.push('${' + `${i + 1}:\\${param[0]}` + '}');
			}
		}
		return `${name}(${templates.join(', ')})`;
	}

	private static getLine(text: string, offset: number) {
		let newlines = 0;
		for (let i = 0; i < offset; i++) {
			if (text.charAt(i) === '\n') {
				++newlines;
			}
		}
		return newlines;
	}

	private getSignatureFromPosition(position: Position): any | undefined {
		const node = AST.findNode(this.ast, position);
		if (node) {
			const fcall = AST.getAncestorOrSelf('FunctionCall', node);
			if (fcall) {
				return AST.getFunctionSignature(fcall);
			}
		}
	}
}
