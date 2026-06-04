/**
 * Strategy interface for server-side language services (diagnostics,
 * completions, hover, definition, and the v7-only set: references,
 * document symbols, semantic tokens, signature help, rename).
 *
 * Two implementations live alongside this file:
 *
 *  - AtomEditorLanguageService — talks to the legacy `/apps/atom-editor/*`
 *    endpoints provided by the `atom-editor-support` XAR. This is the
 *    backward-compatibility path for eXist 6.x. Tested against eXist 6.0.0.
 *  - OpenApiLanguageService — talks to the `/apps/existdb-openapi/api/langservice/*`
 *    endpoints built into eXist 7.0+. This is the modern path with richer
 *    features (multi-error diagnostics, cross-module definition,
 *    references, semantic tokens, etc.).
 *
 * The factory in `./capabilities.ts` runs once per workspace at connect
 * time and returns whichever implementation matches the connected server.
 *
 * v7-only methods are declared optional (`?`) so callers must check
 * `service.references != null` before invoking them; the atom-editor path
 * just doesn't implement them.
 */

import { Diagnostic, Hover, Location, SymbolInformation } from 'vscode-languageserver';
import { TextDocument } from "vscode-languageserver-textdocument";
import { Position } from 'vscode-languageserver';
import { ServerSettings } from '../settings';
import { Import, Symbol, ParsedSignature } from './types';

/** Result of a completions call — the langserver wraps these into LSP CompletionItem. */
export type CompletionsResult = Symbol[];

/**
 * Inputs common to hover / definition / references — both v6 and v7 take
 * different subsets of these. Each implementation pulls what it needs:
 *
 *  - v6 reads `signature` and `imports` (signature-based GET, resolves
 *    imports client-side, file-reads to find the symbol's source line).
 *  - v7 reads `textDocument.getText()` and `position` (POST the whole
 *    expression + 0-indexed cursor, server resolves everything).
 *
 * Always populated by the caller — it doesn't know which path it's on.
 */
export interface LookupContext {
	textDocument: TextDocument;
	position: Position;
	signature: ParsedSignature | null;
	imports: Map<string, Import>;
	relPath: string;
	settings: ServerSettings;
	/** URI of the current document, used by v6 to resolve relative paths. */
	uri: string;
}

export interface CompletionContext {
	text: string;
	prefix: string | null;
	imports: Map<string, Import>;
	relPath: string;
	settings: ServerSettings;
}

export interface LanguageService {
	/** Human-readable label, used in logs ("atom-editor (v6)", "existdb-openapi (v7+)"). */
	readonly label: string;

	/**
	 * Submit the document text for parse/static-error checking.
	 * Returns the list of diagnostics to attach to the document; empty if
	 * the source compiles cleanly.
	 */
	diagnostics(text: string, relPath: string, settings: ServerSettings): Promise<Diagnostic[]>;

	/**
	 * Code completion. `prefix` is the partial token under the cursor (if
	 * any); `imports` lets v6 resolve known prefixes to module URIs.
	 */
	completions(ctx: CompletionContext): Promise<CompletionsResult>;

	/** Hover at the cursor. Returns null when the server has nothing to say. */
	hover(ctx: LookupContext): Promise<Hover | null>;

	/** Go-to-definition at the cursor. */
	definition(ctx: LookupContext): Promise<Location | null>;

	// --- v7-only features (atom-editor-support never had these) ---

	/** Find all references to the symbol at the cursor. */
	references?(ctx: LookupContext): Promise<Location[]>;

	/**
	 * Server-side document symbols (richer than the local AST — includes
	 * return types and parameter types on the openapi path).
	 */
	documentSymbols?(text: string, relPath: string, settings: ServerSettings): Promise<SymbolInformation[]>;

	/**
	 * Symbols suitable for semantic-token highlighting (function /
	 * variable declarations with 0-indexed line/column).
	 */
	semanticSymbols?(text: string, relPath: string, settings: ServerSettings): Promise<Array<{
		name: string;
		kind: number;
		line: number;
		column: number;
	}>>;
}
