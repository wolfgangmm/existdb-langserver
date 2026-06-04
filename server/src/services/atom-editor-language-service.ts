/**
 * eXist 6.x (and older) language service implementation. Talks to the
 * legacy `/apps/atom-editor/*` endpoints provided by the
 * `atom-editor-support` XAR.
 *
 * This is the backward-compatibility path. The code here is preserved
 * from the original (pre-existdb-openapi) langserver — same URLs, same
 * query-param shapes, same response parsing. Tested against eXist 6.0.0.
 *
 * Two characteristics distinguish v6 from v7:
 *
 *  1. **Client-side import resolution.** The atom-editor endpoints
 *     receive a flat list of resolved import URIs/sources as query
 *     parameters; the langserver parses `import module namespace ...`
 *     declarations from the buffer and threads them through every call.
 *     That parsing lives in AnalyzedDocument (which then passes the
 *     resulting `imports` map into the LookupContext / CompletionContext).
 *  2. **Signature-based hover / definition.** Both endpoints accept a
 *     `name#arity` string parsed locally from the AST (rather than a
 *     `(line, column)` cursor), and the response describes the symbol
 *     by file path. For `definition`, this means an extra
 *     `fs.readFile` + local AST walk to find the symbol's line.
 *
 * v6 does not implement `references`, `documentSymbols`, or
 * `semanticSymbols` — those are v7-only features. Leaving the optional
 * methods unset means callers `service.references != null` checks fall
 * through cleanly.
 */

import axios from 'axios';
import { Diagnostic, DiagnosticSeverity, Hover, Location, MarkupKind, Range } from 'vscode-languageserver';
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { ServerSettings } from '../settings';
import { AST } from '../ast';
import { CompletionContext, CompletionsResult, LanguageService, LookupContext } from './language-service';
import { Import, Symbol } from './types';

const funcDefRe = /(?:\(:~(.*?):\))?\s*declare\s+((?:%[\w\:\-]+(?:\([^\)]*\))?\s*)*function\s+([^\(]+)\()/gsm;
const trimRe = /^[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+|[\x09\x0a\x0b\x0c\x0d\x20\xa0\u1680\u180e\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

const ATOM_EDITOR_BASE = '/apps/atom-editor';

export class AtomEditorLanguageService implements LanguageService {
	readonly label = 'atom-editor (v6)';

	constructor(private readonly logger: (message: string, prio?: string) => void = () => {}) {}

	async diagnostics(text: string, relPath: string, settings: ServerSettings): Promise<Diagnostic[]> {
		try {
			const response = await axios.put(`${settings.uri}${ATOM_EDITOR_BASE}/compile.xql`, text, {
				auth: { username: settings.user, password: settings.password },
				headers: {
					'X-BasePath': `${settings.path}/${relPath}`,
					'Content-Type': 'application/octet-stream'
				},
				responseType: 'text'
			});
			if (response.status !== 200) return [];
			const json = JSON.parse(response.data);
			if (json.result === 'pass') return [];
			const error = parseErrorMessage(json.error);
			if (!error.line && error.line !== 0) return [];
			return [{
				severity: DiagnosticSeverity.Error,
				range: Range.create(error.line, error.column, error.line, error.column),
				message: error.msg,
				source: 'xquery'
			}];
		} catch (e) {
			return [];
		}
	}

	async completions(ctx: CompletionContext): Promise<CompletionsResult> {
		const params: any = resolveImports(ctx.imports, false);
		params.base = `${ctx.settings.path}/${ctx.relPath}`;
		if (ctx.prefix) params.prefix = ctx.prefix;
		try {
			const response = await axios.get(`${ctx.settings.uri}${ATOM_EDITOR_BASE}/atom-autocomplete.xql`, {
				auth: { username: ctx.settings.user, password: ctx.settings.password },
				params,
				responseType: 'text'
			});
			if (response.status !== 200) return [];
			const json = JSON.parse(response.data);
			if (!Array.isArray(json)) return [];
			return json.map((item: any) => ({
				signature: item.text,
				type: item.type,
				snippet: (item.snippet || '').replace(/\:\$/g, ':\\\$'),
				name: item.name,
				documentation: item.description
			} as Symbol));
		} catch (e) {
			return [];
		}
	}

	async hover(ctx: LookupContext): Promise<Hover | null> {
		if (!ctx.signature) return null;
		const params = makeSignatureParams(ctx.signature, ctx.imports, ctx.relPath, ctx.settings);
		try {
			const response = await axios.get(`${ctx.settings.uri}${ATOM_EDITOR_BASE}/atom-autocomplete.xql`, {
				auth: { username: ctx.settings.user, password: ctx.settings.password },
				params,
				responseType: 'text'
			});
			if (response.status !== 200) return null;
			const json = JSON.parse(response.data);
			if (!Array.isArray(json) || json.length === 0) {
				this.logger(`hover: no description found for ${params.signature}`, 'info');
				return null;
			}
			const desc = json[0];
			const md = [`**${desc.text}** as **${desc.leftLabel}**`];
			if (desc.description) md.push(desc.description);
			if (desc.arguments && desc.arguments.length > 0) {
				desc.arguments.forEach((arg: any) => {
					md.push(`**\$${arg.name}** *${arg.type}* ${arg.description}`);
				});
			}
			return { contents: { kind: MarkupKind.Markdown, value: md.join('\n\n') } };
		} catch (e) {
			return null;
		}
	}

	async definition(ctx: LookupContext): Promise<Location | null> {
		if (!ctx.signature) return null;
		const params = makeSignatureParams(ctx.signature, ctx.imports, ctx.relPath, ctx.settings);
		try {
			const response = await axios.get(`${ctx.settings.uri}${ATOM_EDITOR_BASE}/atom-autocomplete.xql`, {
				auth: { username: ctx.settings.user, password: ctx.settings.password },
				params,
				responseType: 'text'
			});
			if (response.status !== 200) return null;
			const json = JSON.parse(response.data);
			if (!Array.isArray(json) || json.length === 0) {
				this.logger(`no description found for ${params.signature}`, 'info');
				return null;
			}
			const desc = json[0];
			const rp = path.relative(`${ctx.settings.path}/${ctx.relPath}`, desc.path);
			const fp = URI.parse(ctx.uri).fsPath;
			const absPath = path.resolve(path.dirname(fp), rp);
			return new Promise((resolve) => {
				fs.readFile(absPath, { encoding: 'utf-8' }, (err, content) => {
					if (err || !content) {
						this.logger(`failed to parse ${absPath}`, 'error');
						resolve(null);
						return;
					}
					const contentStr: string = content as any;
					const symbol = findFunctionLocation(contentStr, ctx.signature!.name, ctx.signature!.arity);
					if (symbol) {
						resolve({
							uri: URI.file(absPath).toString(),
							range: {
								start: { line: symbol.start, character: 0 },
								end: { line: symbol.end + 1, character: Number.MAX_VALUE }
							}
						});
					} else {
						resolve(null);
					}
				});
			});
		} catch (e) {
			return null;
		}
	}
}

// ---- helpers (extracted from master's AnalyzedDocument) ----

function resolveImports(imports: Map<string, Import>, includeJava = true): {
	mprefix: string[], uri: string[], source: string[], base: string, prefix?: string, signature?: string
} {
	const prefixes: string[] = [];
	const uris: string[] = [];
	const sources: string[] = [];
	for (const imp of imports.values()) {
		if (!imp.isJava || includeJava) {
			prefixes.push(imp.prefix);
			uris.push(imp.uri);
			if (imp.source) sources.push(imp.source);
		}
	}
	return { mprefix: prefixes, uri: uris, source: sources, base: '' };
}

function makeSignatureParams(
	signature: { name: string; arity: number },
	imports: Map<string, Import>,
	relPath: string,
	settings: ServerSettings
) {
	// If the signature has a known import prefix, scope the resolution to
	// that one module; otherwise pass all known imports.
	const prefix = signature.name.split(':');
	let importsForCall: Map<string, Import>;
	if (prefix.length === 2 && imports.has(prefix[0])) {
		importsForCall = new Map([[prefix[0], imports.get(prefix[0])!]]);
	} else {
		importsForCall = imports;
	}
	const params: any = resolveImports(importsForCall, false);
	params.base = `${settings.path}/${relPath}`;
	params.signature = `${signature.name}#${signature.arity}`;
	return params;
}

/**
 * Find a function declaration matching `name#arity` in the given source.
 * Used by the v6 definition path after reading the target file off disk
 * (the atom-editor endpoint returns a file path; we then have to walk it
 * locally to find the actual line number).
 *
 * Returns a {start, end} pair of 0-indexed line numbers, or null when no
 * matching declaration is found.
 */
function findFunctionLocation(text: string, name: string, arity: number): { start: number; end: number } | null {
	funcDefRe.lastIndex = 0;
	let match = funcDefRe.exec(text);
	while (match) {
		const declName = match[3].replace(trimRe, '');
		if (declName === name) {
			// Count arity from the parameter list.
			const offset = funcDefRe.lastIndex;
			const end = findMatchingParen(text, offset);
			const argsStr = text.substring(offset, end);
			let count = 0;
			if (argsStr.indexOf(',') > -1) {
				count = argsStr.split(/\s*,\s*/).length;
			} else if (argsStr.trim() !== '') {
				count = 1;
			}
			if (count === arity) {
				const startLine = countLines(text.substring(0, match.index));
				const endLine = countLines(text.substring(0, end));
				return { start: startLine, end: endLine };
			}
		}
		match = funcDefRe.exec(text);
	}
	return null;
}

function findMatchingParen(text: string, offset: number): number {
	let depth = 1;
	let i = offset;
	while (i < text.length && depth > 0) {
		const ch = text.charAt(i);
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		if (depth === 0) return i;
		i++;
	}
	return text.length;
}

function countLines(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return n;
}

function parseErrorMessage(error: any) {
	let msg: string;
	if (error && error.line) {
		msg = error['#text'];
	} else {
		msg = error;
	}
	const str = /.*line:?\s*(\d+),\s*column:?\s*(\d+)/i.exec(msg);
	let line = 0;
	let column = 0;
	if (str && str.length === 3) {
		line = parseInt(str[1]) - 1;
		column = parseInt(str[2]) - 1;
	} else if (error) {
		line = parseInt(error.line) - 1;
		column = parseInt(error.column) - 1;
	}
	return { line: Math.max(line, 0), column: Math.max(column, 0), msg };
}

/**
 * Parse `import module namespace ... at "..."` declarations out of the
 * given source text and populate the given imports map.
 *
 * Exported so AnalyzedDocument can call it as it analyzes buffer changes;
 * the resulting map then rides through the LookupContext / CompletionContext
 * for v6 lookups. v7 doesn't use this (server resolves its own imports).
 */
const importRe = /(import\s+module\s+namespace\s+[^=]+\s*=\s*["'][^"']+["']\s*(?:at\s+["'][^"']+["'])?\s*;)/g;
const moduleRe = /import\s+module\s+namespace\s+([^=\s]+)\s*=\s*["']([^"']+)["']\s*at\s+["']([^"']+)["']\s*;/;

export function parseImports(text: string, imports: Map<string, Import>): void {
	imports.clear();
	importRe.lastIndex = 0;
	let match = importRe.exec(text);
	while (match != null) {
		if (match[1]) {
			const inner = moduleRe.exec(match[1]);
			if (inner && inner.length === 4) {
				const isJava = inner[3].substring(0, 5) === 'java:';
				imports.set(inner[1], {
					prefix: inner[1],
					uri: inner[2],
					source: inner[3],
					isJava
				});
			}
		}
		match = importRe.exec(text);
	}
}
