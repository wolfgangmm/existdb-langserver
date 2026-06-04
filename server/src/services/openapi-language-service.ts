/**
 * eXist 7.0+ language service implementation. Talks to the
 * `/apps/existdb-openapi/api/langservice/*` endpoints built into eXist
 * 7.0+ (see https://github.com/eXist-db/existdb-openapi).
 *
 * Request convention shared across all endpoints (per the OpenAPI spec):
 *   - request-body field name is `expression` (not `query`)
 *   - `line` and `column` are 0-indexed (matching the LSP Position
 *     convention), so they pass through from `position.line` /
 *     `position.character` without offsetting
 *   - responses likewise use 0-indexed line/column
 */

import axios from 'axios';
import { Diagnostic, DiagnosticSeverity, Hover, Location, MarkupKind, Range, SymbolInformation, SymbolKind } from 'vscode-languageserver';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { ServerSettings } from '../settings';
import { CompletionContext, CompletionsResult, LanguageService, LookupContext } from './language-service';
import { Symbol } from './types';

const OPENAPI_BASE = '/apps/existdb-openapi/api/langservice';

export class OpenApiLanguageService implements LanguageService {
	readonly label = 'existdb-openapi (v7+)';

	constructor(private readonly logger: (message: string, prio?: string) => void = () => {}) {}

	async diagnostics(text: string, relPath: string, settings: ServerSettings): Promise<Diagnostic[]> {
		try {
			const response = await axios.post(`${settings.uri}${OPENAPI_BASE}/diagnostics`, {
				expression: text,
				'module-load-path': `${settings.path}/${relPath}`
			}, {
				auth: { username: settings.user, password: settings.password },
				headers: { 'Content-Type': 'application/json' },
				responseType: 'json'
			});
			if (response.status !== 200) return [];
			const diags: any[] = response.data;
			if (!Array.isArray(diags)) return [];
			return diags.map(d => {
				// existdb-openapi returns 0-indexed line/column, same as LSP — pass through.
				const line = Math.max(d.line || 0, 0);
				const column = Math.max(d.column || 0, 0);
				return {
					severity: mapSeverity(d.severity),
					range: Range.create(line, column, line, column),
					message: d.message,
					code: d.code,
					source: 'xquery'
				} as Diagnostic;
			});
		} catch (e) {
			return [];
		}
	}

	async completions(ctx: CompletionContext): Promise<CompletionsResult> {
		try {
			const body: any = {
				expression: ctx.text,
				'module-load-path': `${ctx.settings.path}/${ctx.relPath}`
			};
			if (ctx.prefix) body.prefix = ctx.prefix;
			const response = await axios.post(`${ctx.settings.uri}${OPENAPI_BASE}/completions`, body, {
				auth: { username: ctx.settings.user, password: ctx.settings.password },
				headers: { 'Content-Type': 'application/json' },
				responseType: 'json'
			});
			if (response.status !== 200) return [];
			const items: any[] = response.data;
			if (!Array.isArray(items)) return [];
			return items.map((item: any) => ({
				signature: item.text,
				type: item.type,
				snippet: (item.snippet || item.text || '').replace(/\:\$/g, ':\\\$'),
				name: item.name,
				documentation: item.description
			} as Symbol));
		} catch (e) {
			return [];
		}
	}

	async hover(ctx: LookupContext): Promise<Hover | null> {
		try {
			const response = await axios.post(`${ctx.settings.uri}${OPENAPI_BASE}/hover`, {
				expression: ctx.textDocument.getText(),
				line: ctx.position.line,
				column: ctx.position.character,
				'module-load-path': `${ctx.settings.path}/${ctx.relPath}`
			}, {
				auth: { username: ctx.settings.user, password: ctx.settings.password },
				headers: { 'Content-Type': 'application/json' },
				responseType: 'json'
			});
			if (response.status !== 200) return null;
			const hover = response.data;
			if (!hover || !hover.contents) return null;
			return {
				contents: {
					kind: MarkupKind.Markdown,
					value: hover.contents
				}
			};
		} catch (e) {
			return null;
		}
	}

	async definition(ctx: LookupContext): Promise<Location | null> {
		try {
			const response = await axios.post(`${ctx.settings.uri}${OPENAPI_BASE}/definition`, {
				expression: ctx.textDocument.getText(),
				line: ctx.position.line,
				column: ctx.position.character,
				'module-load-path': `${ctx.settings.path}/${ctx.relPath}`
			}, {
				auth: { username: ctx.settings.user, password: ctx.settings.password },
				headers: { 'Content-Type': 'application/json' },
				responseType: 'json'
			});
			if (response.status !== 200) return null;
			const def = response.data;
			if (!def || (!def.line && def.line !== 0)) return null;

			// existdb-openapi returns 0-indexed line/column, same as LSP — pass through.
			const defLine = Math.max(def.line, 0);
			const defCol = Math.max(def.column || 0, 0);

			// Cross-module: map server-side db path back to a workspace file URI when possible.
			let targetUri = ctx.uri;
			if (def.uri && ctx.settings.path) {
				const dbPath: string = def.uri;
				const dbRoot: string = ctx.settings.path;
				if (dbPath.startsWith(dbRoot)) {
					const relModulePath = dbPath.substring(dbRoot.length);
					const currentFilePath = URI.parse(ctx.uri).fsPath;
					const workspaceRoot = currentFilePath.substring(
						0,
						currentFilePath.length - ctx.relPath.length - path.basename(currentFilePath).length
					);
					const targetPath = path.join(workspaceRoot, relModulePath);
					targetUri = URI.file(targetPath).toString();
				}
			}

			return {
				uri: targetUri,
				range: Range.create(defLine, defCol, defLine, defCol)
			};
		} catch (e) {
			return null;
		}
	}

	async references(ctx: LookupContext): Promise<Location[]> {
		try {
			const response = await axios.post(`${ctx.settings.uri}${OPENAPI_BASE}/references`, {
				expression: ctx.textDocument.getText(),
				line: ctx.position.line,
				column: ctx.position.character,
				'module-load-path': `${ctx.settings.path}/${ctx.relPath}`
			}, {
				auth: { username: ctx.settings.user, password: ctx.settings.password },
				headers: { 'Content-Type': 'application/json' },
				responseType: 'json'
			});
			if (response.status !== 200 || !Array.isArray(response.data)) return [];
			// existdb-openapi returns 0-indexed line/column, same as LSP — pass through.
			return response.data.map((ref: any) => ({
				uri: ctx.uri,
				range: Range.create(
					Math.max(ref.line, 0),
					Math.max(ref.column || 0, 0),
					Math.max(ref.line, 0),
					Math.max(ref.column || 0, 0)
				)
			}));
		} catch (e) {
			return [];
		}
	}

	async documentSymbols(text: string, relPath: string, settings: ServerSettings): Promise<SymbolInformation[]> {
		try {
			const response = await axios.post(`${settings.uri}${OPENAPI_BASE}/symbols`, {
				expression: text,
				'module-load-path': `${settings.path}/${relPath}`
			}, {
				auth: { username: settings.user, password: settings.password },
				headers: { 'Content-Type': 'application/json' },
				responseType: 'json'
			});
			if (response.status !== 200 || !Array.isArray(response.data) || response.data.length === 0) return [];
			return response.data.map((sym: any) => ({
				name: sym.detail || sym.name,
				kind: sym.kind === 12 ? SymbolKind.Function : SymbolKind.Variable,
				location: {
					uri: '',  // populated by caller (server.ts knows the current uri)
					range: Range.create(sym.line || 0, sym.column || 0, sym.line || 0, sym.column || 0)
				}
			}));
		} catch (e) {
			return [];
		}
	}

	async semanticSymbols(text: string, relPath: string, settings: ServerSettings) {
		try {
			const response = await axios.post(`${settings.uri}${OPENAPI_BASE}/symbols`, {
				expression: text,
				'module-load-path': `${settings.path}/${relPath}`
			}, {
				auth: { username: settings.user, password: settings.password },
				headers: { 'Content-Type': 'application/json' },
				responseType: 'json'
			});
			if (response.status !== 200 || !Array.isArray(response.data)) return [];
			return response.data.map((s: any) => ({
				name: s.name || '',
				kind: s.kind || 12,
				line: s.line || 0,
				column: s.column || 0
			}));
		} catch (e) {
			return [];
		}
	}
}

function mapSeverity(severity: any): DiagnosticSeverity {
	const s = typeof severity === 'number' ? severity : parseInt(String(severity), 10);
	switch (s) {
		case 1: return DiagnosticSeverity.Error;
		case 2: return DiagnosticSeverity.Warning;
		case 3: return DiagnosticSeverity.Information;
		case 4: return DiagnosticSeverity.Hint;
		default: return DiagnosticSeverity.Error;
	}
}
