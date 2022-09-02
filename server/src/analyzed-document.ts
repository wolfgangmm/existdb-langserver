import { Diagnostic, CompletionItem, CompletionItemKind, InsertTextFormat, ResponseError, ErrorCodes, SymbolInformation, TextDocument, Range, Position, Hover, MarkupKind, Location } from 'vscode-languageserver';
import { ServerSettings } from './settings';
import { AST } from './ast';
import * as request from 'request';
import * as path from 'path';
import * as fs from 'fs';
import { URI } from 'vscode-uri';

// require('request-debug')(request);

const funcDefRe = /(?:\(:~(.*?):\))?\s*declare\s+((?:%[\w\:\-]+(?:\([^\)]*\))?\s*)*function\s+([^\(]+)\()/gsm;
const trimRe = /^[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+|[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const paramRe = /\$[^\s]+/;
const importRe = /(import\s+module\s+namespace\s+[^=]+\s*=\s*["'][^"']+["']\s*(?:at\s+["'][^"']+["'])?\s*;)/g;
const moduleRe = /import\s+module\s+namespace\s+([^=\s]+)\s*=\s*["']([^"']+)["']\s*at\s+["']([^"']+)["']\s*;/;

interface Import {
	prefix: string;
	uri: string;
	source?: string;
	isJava?: boolean;
}

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

	imports: Map<string, Import> = new Map();

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
		this.parseImports(text);
	}

	async gotoDefinition(position: Position, relPath: string, textDocument: TextDocument, settings: ServerSettings): Promise<Location | null> {
		if (!this.ast) {
			return null;
		}
		const signature = this.getSignatureFromPosition(position);
		if (signature) {
			const symbol = this.symbolsMap.get(`${signature.name}#${signature.arity}`);
			if (symbol && symbol.location) {
				return {
					uri: this.uri,
					range: this.computeLocation(textDocument, symbol.location)
				};
			} else {
				return this.gotoDefinitionRemote(signature, relPath, textDocument, settings);
			}
		}
		return null;
	}

	private async gotoDefinitionRemote(signature: any, relPath: string, textDocument: TextDocument, settings: ServerSettings): Promise<Location | null> {
		const params = this.getParameters(signature, relPath, settings);
		return new Promise(resolve => {
			request(this.getOptions(params, settings), (error, response, body) => {
				if (error || response.statusCode !== 200) {
					this.status(false, settings);
					resolve(null);
				} else {
					const json = JSON.parse(body);
					if (json.length == 0) {
						this.logger(`no description found for ${params.signature}`, 'info');
					} else {
						this.status(true, settings);
						const desc = json[0];
						const rp = path.relative(`${settings.path}/${relPath}`, desc.path);
						const fp = URI.parse(this.uri).fsPath;
						const absPath = path.resolve(path.dirname(fp), rp);
						console.log(`reading ${absPath}`);
						fs.readFile(absPath, { encoding: 'UTF-8' }, (err, content) => {
							if (error || !content) {
								this.logger(`failed to parse ${absPath}`, 'error');
								resolve(null);
								return;
							}
							const symbol = AnalyzedDocument.getLocalSymbol(content, signature.name, signature.arity);
							if (symbol && symbol.location) {
								resolve({
									uri: URI.file(absPath).toString(),
									range: {
										start: {
											line: symbol.location.start,
											character: 0
										},
										end: {
											line: symbol.location.end + 1,
											character: Number.MAX_VALUE
										}
									}
								});
							}
						});
					}
				}
			});
		});
	}

	async getHover(position: Position, relPath: string, settings: ServerSettings): Promise<Hover | null> {
		if (!this.ast) {
			return null;
		}
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
			} else {
				return this.getHoverRemote(signature, relPath, settings);
			}
		}
		return null;
	}

	private async getHoverRemote(signature: any, relPath: string, settings: ServerSettings): Promise<Hover | null> {
		const params = this.getParameters(signature, relPath, settings);
		return new Promise(resolve => {
			request(this.getOptions(params, settings), (error, response, body) => {
				if (error || response.statusCode !== 200) {
					this.status(false, settings);
					resolve(null);
				} else {
					this.status(true, settings);
					const json = JSON.parse(body);
					if (json.length == 0) {
						this.logger(`hover: no description found for ${params.signature}`, 'info');
					} else {
						const desc = json[0];
						const md = [`**${desc.text}** as **${desc.leftLabel}**`];
						if (desc.description) {
							md.push(desc.description);
						}
						if (desc.arguments && desc.arguments.length > 0) {
							desc.arguments.forEach((arg: any) => {
								md.push(`**\$${arg.name}** *${arg.type}* ${arg.description}`);
							});
						}
						resolve({
							contents: {
								kind: MarkupKind.Markdown,
								value: md.join('\n\n')
							}
						});
					}
				}
			});
		});
	}

	private getParameters(signature: any, relPath: string, settings: ServerSettings) {
		let imports: any;
		const prefix = signature.name.split(':');
		if (prefix.length === 2) {
			const imp = this.imports.get(prefix[0]);
			if (imp) {
				imports = [imp];
			}
		}
		if (!imports) {
			imports = this.imports.values();
		}
		const params = this.resolveImports(imports, false);
		params.base = `${settings.path}/${relPath}`;
		params.signature = `${signature.name}#${signature.arity}`;
		return params;
	}

	getCompletions(prefix: string | null, relPath: string, settings: ServerSettings): Promise<CompletionItem[] | ResponseError<any>> {
		const params = this.resolveImports(this.imports.values(), false);
		params.base = `${settings.path}/${relPath}`;
		if (prefix) {
			params.prefix = prefix;
		}
		return new Promise(resolve => {
			request(this.getOptions(params, settings), (error, response, body) => {
				if (error || response.statusCode !== 200) {
					this.status(false, settings);
					resolve(new ResponseError(ErrorCodes.InvalidRequest, error));
				} else {
					this.status(true, settings);
					const json = JSON.parse(body);
					const symbols: any[] = [];
					json.forEach((item: { text: string; snippet: string; type: string; name: string; description: string; }) => {
						const symbol: Symbol = {
							signature: item.text,
							type: item.type,
							snippet: item.snippet.replace(/\:\$/g, ':\\\$'),
							name: item.name,
							documentation: item.description
						};
						symbols.push(symbol);
						this.symbolsMap.set(symbol.name, symbol);
					});
					resolve(this.mapCompletions(this.localSymbols).concat(this.mapCompletions(symbols)));
				}
			});
		});
	}

	getDocumentSymbols(textDocument: TextDocument): SymbolInformation[] {
		return this.mapDocumentSymbols(this.localSymbols, textDocument);
	}

	executeQuery(query: string, settings: ServerSettings, relPath: string): Promise<any> {
		const params = {
			output: this.getOutputMode(query),
			qu: query,
			count: 100,
			base: `${settings.path}/${relPath}`
		};
		const options = {
			uri: `${settings.uri}/apps/atom-editor/execute`,
			method: "POST",
			form: params,
			auth: {
				user: settings.user,
				password: settings.password,
				sendImmediately: true
			}
		}
		this.logger(`Execute query with output mode: ${params.output}, path: ${params.base}`);
		return new Promise((resolve, reject) => {
			request(options, (error, response, body) => {
				if (!response) {
					reject(error);
				}
				const resultCount = response.headers['x-result-count'];
				const queryTime = response.headers['x-elapsed'];
				const queryResponse = {
					output: params.output,
					hits: resultCount,
					elapsed: queryTime,
					results: body
				};
				resolve(queryResponse);
			});
		});
	}

	private getOutputMode(content: string) {
		const match = /declare\s+option.*:method\s+"(.*)"\s*;/.exec(content);
		if (match) {
			return match[1];
		}
		return 'adaptive';
	}

	private getOptions(params: any, settings: ServerSettings, target: string = 'atom-autocomplete.xql') {
		return {
			uri: `${settings.uri}/apps/atom-editor/${target}`,
			method: "GET",
			qs: params,
			useQuerystring: true,
			auth: {
				user: settings.user,
				password: settings.password,
				sendImmediately: true
			}
		};
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
				// const status = funcDef[2].indexOf("%private") == -1 ? "private" : 'public';
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

	private parseImports(text: string) {
		this.imports.clear();
		let match = importRe.exec(text);

		while (match != null) {
			if (match[1]) {
				const imp = match[1];
				match = moduleRe.exec(imp);
				if (match && match.length === 4) {
					const isJava = match[3].substring(0, 5) == "java:";
					const importData = {
						prefix: match[1],
						uri: match[2],
						source: match[3],
						isJava: isJava
					};
					this.imports.set(importData.prefix, importData);
				}
			}
			match = importRe.exec(text);
		}
	}

	private resolveImports(imports: IterableIterator<Import>, includeJava = true): {
		mprefix: string[], uri: string[], source: string[], base: string, prefix?: string,
		signature?: string
	} {
		const prefixes: string[] = [];
		const uris: string[] = [];
		const sources: string[] = [];
		for (let imp of imports) {
			if (!imp.isJava || includeJava) {
				prefixes.push(imp.prefix);
				uris.push(imp.uri);
				if (imp.source) {
					sources.push(imp.source);
				}
			}
		}
		return {
			mprefix: prefixes,
			uri: uris,
			source: sources,
			base: ''
		};
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