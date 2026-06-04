/**
 * Per-document analysis state: the local AST (for cursor-position lookups
 * without a server roundtrip), the local symbol table extracted from the
 * buffer text via regex, and the parsed `import module namespace` map
 * used by the v6 atom-editor service for client-side import resolution.
 *
 * Remote calls (hover / definition / completions / diagnostics) are
 * delegated to a LanguageService — either AtomEditorLanguageService (v6)
 * or OpenApiLanguageService (v7+) — selected at workspace connect time
 * by `services/capabilities.ts`. Server-side handlers in `server.ts` use
 * `getSignatureFromPosition` + `imports` from this class plus their own
 * settings to build the LookupContext / CompletionContext that the
 * service consumes; that keeps the strategy stateless.
 *
 * @author Wolfgang Meier (original); refactored to delegate remote calls
 * to a LanguageService strategy when openapi support was added.
 */

import { CompletionItem, CompletionItemKind, Diagnostic, InsertTextFormat, SymbolInformation, TextDocument, Range, Position, Hover, Location } from 'vscode-languageserver';
import { ServerSettings } from './settings';
import { AST } from './ast';
import { Import, Symbol, ParsedSignature } from './services/types';
import { LanguageService, LookupContext, CompletionContext } from './services/language-service';
import { parseImports } from './services/atom-editor-language-service';

const funcDefRe = /(?:\(:~(.*?):\))?\s*declare\s+((?:%[\w\:\-]+(?:\([^\)]*\))?\s*)*function\s+([^\(]+)\()/gsm;
const trimRe = /^[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+|[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const paramRe = /\$[^\s]+/;

export class AnalyzedDocument {

	uri: string;

	diagnostics: Diagnostic[] = [];

	localSymbols: Symbol[] = [];

	symbolsMap: Map<string, Symbol> = new Map();

	imports: Map<string, Import> = new Map();

	ast: any;

	logger: (message: string, prio?: string) => void;

	status: (message: boolean | string, settings?: ServerSettings) => void;

	/**
	 * The LanguageService used for remote calls. Set by server.ts after
	 * capability detection completes. Until set, remote calls return
	 * null / empty (the document is still locally useful for hover /
	 * goto-def hits resolved entirely from the buffer AST).
	 */
	service: LanguageService | null = null;

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
		parseImports(text, this.imports);
	}

	async gotoDefinition(position: Position, relPath: string, textDocument: TextDocument, settings: ServerSettings): Promise<Location | null> {
		// 1. Local AST first — symbols declared in this buffer resolve
		//    without a server roundtrip on either v6 or v7.
		const signature = this.getSignatureFromPosition(position);
		if (signature) {
			const symbol = this.symbolsMap.get(`${signature.name}#${signature.arity}`);
			if (symbol && symbol.location) {
				return {
					uri: this.uri,
					range: this.computeLocation(textDocument, symbol.location)
				};
			}
		}
		// 2. Otherwise delegate to the active language service.
		if (!this.service) return null;
		const ctx = this.buildLookupContext(textDocument, position, signature, relPath, settings);
		try {
			return await this.service.definition(ctx);
		} catch (e) {
			this.status(false, settings);
			return null;
		}
	}

	async getHover(position: Position, relPath: string, textDocument: TextDocument, settings: ServerSettings): Promise<Hover | null> {
		const signature = this.getSignatureFromPosition(position);
		if (signature) {
			const symbol = this.symbolsMap.get(`${signature.name}#${signature.arity}`);
			if (symbol) {
				const md = [`**${symbol.signature}**`];
				if (symbol.documentation) md.push(symbol.documentation);
				return {
					contents: { kind: 'markdown', value: md.join('\n\n') } as any
				};
			}
		}
		if (!this.service) return null;
		const ctx = this.buildLookupContext(textDocument, position, signature, relPath, settings);
		try {
			return await this.service.hover(ctx);
		} catch (e) {
			this.status(false, settings);
			return null;
		}
	}

	async getCompletions(text: string, prefix: string | null, relPath: string, settings: ServerSettings): Promise<CompletionItem[]> {
		if (!this.service) {
			// No remote, fall back to local-only completions.
			return mapCompletions(this.localSymbols);
		}
		const ctx: CompletionContext = {
			text,
			prefix,
			imports: this.imports,
			relPath,
			settings
		};
		try {
			const remote = await this.service.completions(ctx);
			// Track remote-returned symbols in symbolsMap so subsequent
			// hover/definition lookups can hit them locally without
			// re-roundtripping.
			remote.forEach(s => this.symbolsMap.set(s.name, s));
			return mapCompletions(this.localSymbols).concat(mapCompletions(remote));
		} catch (e) {
			this.status(false, settings);
			return mapCompletions(this.localSymbols);
		}
	}

	getDocumentSymbols(textDocument: TextDocument): SymbolInformation[] {
		return mapDocumentSymbols(this.localSymbols, textDocument, this.uri,
			(offsets) => this.computeLocation(textDocument, offsets));
	}

	getSignatureFromPosition(position: Position): ParsedSignature | undefined {
		if (!this.ast) return undefined;
		const node = AST.findNode(this.ast, position);
		if (node) {
			const fcall = AST.getAncestorOrSelf('FunctionCall', node);
			if (fcall) {
				return AST.getFunctionSignature(fcall);
			}
		}
		return undefined;
	}

	private buildLookupContext(textDocument: TextDocument, position: Position, signature: ParsedSignature | undefined,
		relPath: string, settings: ServerSettings): LookupContext {
		return {
			textDocument,
			position,
			signature: signature || null,
			imports: this.imports,
			relPath,
			settings,
			uri: this.uri
		};
	}

	private computeLocation(textDocument: TextDocument, offsets: { start: number; end: number; }): Range {
		return {
			start: textDocument.positionAt(offsets.start),
			end: textDocument.positionAt(offsets.end)
		};
	}

	// --- local symbol parsing (unchanged from master) ---

	private static getLocalSymbols(text: string, lineCount: boolean, map: Map<string, Symbol> = new Map()): Map<string, Symbol> {
		funcDefRe.lastIndex = 0;
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
					location = { start: line, end: line };
				} else {
					location = { start: offset, end: end };
				}
				const symbol: Symbol = {
					signature: signature,
					type: 'function',
					name: `${name}#${arity}`,
					snippet: AnalyzedDocument.getSnippet(name, args),
					location: location
				};
				if (documentation) symbol.documentation = documentation;
				map.set(symbol.name, symbol);
			}
			funcDef = funcDefRe.exec(text);
		}
		return map;
	}

	private static findMatchingParen(text: string, offset: number) {
		let depth = 1;
		for (let i = offset; i < text.length; i++) {
			let ch = text.charAt(i);
			if (ch === ')') {
				depth -= 1;
				if (depth === 0) return i;
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
			if (text.charAt(i) === '\n') ++newlines;
		}
		return newlines;
	}
}

// ---- Symbol → LSP CompletionItem / SymbolInformation mapping ----

function mapCompletions(symbols: Symbol[]): CompletionItem[] {
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

function mapDocumentSymbols(symbols: Symbol[], textDocument: TextDocument, uri: string,
	computeRange: (offsets: { start: number; end: number; }) => Range): SymbolInformation[] {
	return symbols.map(symbol => ({
		name: symbol.signature,
		kind: symbol.type === 'function' ? CompletionItemKind.Function : CompletionItemKind.Variable,
		location: {
			uri,
			range: symbol.location ? computeRange(symbol.location) : Range.create(0, 0, 0, 0)
		}
	}));
}
