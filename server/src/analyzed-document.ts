import { Diagnostic, CompletionItem, CompletionItemKind, InsertTextFormat, ResponseError, ErrorCodes, SymbolInformation, TextDocument, Range, Position, Hover, MarkupKind } from 'vscode-languageserver';
import { ServerSettings } from './settings';
import { AST } from './ast';
import * as request from 'request';

const funcDefRe = /(?:\(:~(.*?):\))?\s*declare\s+((?:%[\w\:\-]+(?:\([^\)]*\))?\s*)*function\s+([^\(]+)\()/gsm;
const trimRe = /^[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+|[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const paramRe = /\$[^\s]+/;
const importRe = /(import\s+module\s+namespace\s+[^=]+\s*=\s*["'][^"']+["']\s*(?:at\s+["'][^"']+["'])?\s*;)/g;
const moduleRe = /import\s+module\s+namespace\s+([^=\s]+)\s*=\s*["']([^"']+)["']\s*at\s+["']([^"']+)["']\s*;/;

interface Symbol {
	signature: string;
	type: string;
	name: string;
	snippet: string;
	documentation?: string;
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

	symbolsComplete: boolean = false;

	imports: string[] = [];

	ast: any;

	constructor(uri: string, text: string | null = null) {
		this.uri = uri;
		if (text) {
			this.analyze(text);
		}
	}

	analyze(text: string) {
		this.getLocalSymbols(text);
		this.parseImports(text);
	}

	getHover(position: Position): Hover | null {
		if (!this.ast) {
			return null;
		}
		const node = AST.findNode(this.ast, position);
		if (node) {
			const fcall = AST.getAncestorOrSelf('FunctionCall', node);
			if (fcall) {
				const signature = AST.getFunctionSignature(fcall);
				if (signature) {
					const symbol = this.symbolsMap.get(`${signature.name}#${signature.arity}`);
					if (symbol) {
						const md = [symbol.signature];
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
				}
			}
		}
		return null;
	}

	getCompletions(prefix: string | null, relPath: string, settings: ServerSettings): Promise<CompletionItem[] | ResponseError<any>> {
		const params = this.resolveImports(this.imports, false);
		params.base = `${settings.path}/${relPath}`;
		if (prefix) {
			params.prefix = prefix;
		}
		return new Promise(resolve => {
			const options = {
				uri: `${settings.uri}/apps/atom-editor/atom-autocomplete.xql`,
				method: "GET",
				qs: params,
				useQuerystring: true,
				auth: {
					user: settings.user,
					password: settings.password,
					sendImmediately: true
				}
			};
			request(options, (error, response, body) => {
				if (error || response.statusCode !== 200) {
					resolve(new ResponseError(ErrorCodes.RequestCancelled, error));
				} else {
					const json = JSON.parse(body);
					const symbols: any[] = [];
					json.forEach((item: { text: string; snippet: string; type: string; name: string; description: string; }) => {
						const symbol: Symbol = {
							signature: item.text,
							type: item.type,
							snippet: item.snippet.replace(/\${(\d+):(.*?)}/g, '\${$1|$2|}'),
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
		function computeLocation(offsets: { start: number; end: number; }): Range {
			return {
				start: textDocument.positionAt(offsets.start),
				end: textDocument.positionAt(offsets.end)
			};
		}
		return symbols.map(symbol => {
			return {
				name: symbol.signature,
				kind: symbol.type === 'function' ? CompletionItemKind.Function : CompletionItemKind.Variable,
				location: {
					uri: this.uri,
					range: computeLocation(symbol.location)
				}
			};
		});
	}

	private getLocalSymbols(text: string) {
		this.localSymbols = [];
		let funcDef = funcDefRe.exec(text);
		while (funcDef) {
			if (funcDef[2]) {
				const offset = funcDefRe.lastIndex;
				const end = this.findMatchingParen(text, offset);

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

				const symbol: Symbol = {
					signature: signature,
					type: 'function',
					name: `${name}#${arity}`,
					snippet: this.getSnippet(name, args),
					location: {
						start: offset,
						end: end
					}
				};
				if (documentation) {
					symbol.documentation = documentation;
				}
				this.localSymbols.push(symbol);
				this.symbolsMap.set(symbol.name, symbol);
			}
			funcDef = funcDefRe.exec(text);
		}
	}

	private findMatchingParen(text: string, offset: number) {
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

	private getSnippet(name: string, args: string[]) {
		let templates = [];
		for (let i = 0; i < args.length; i++) {
			const param = paramRe.exec(args[i]);
			if (param) {
				templates.push('${' + `${i + 1}|${param[0]}` + '|}');
			}
		}
		return `${name}(${templates.join(', ')})`;
	}

	private parseImports(text: string) {
		this.imports = [];
		let match = importRe.exec(text);

		while (match != null) {
			if (match[1]) {
				this.imports.push(match[1]);
			}
			match = importRe.exec(text);
		}
	}

	private resolveImports(imports: string[], includeJava = true) {
		const prefixes = [];
		const uris = [];
		const sources = [];
		for (let i = 0; i < imports.length; i++) {
			const imp = imports[i];
			const matches = moduleRe.exec(imp);
			if (matches && matches.length === 4) {
				const isJava = matches[3].substring(0, 5) == "java:";
				if (!isJava || includeJava) {
					prefixes.push(matches[1]);
					uris.push(matches[2]);
					sources.push(matches[3]);
				}
			}
		}
		return {
			mprefix: prefixes,
			uri: uris,
			source: sources,
			base: '',
			prefix: ''
		};
	}
}