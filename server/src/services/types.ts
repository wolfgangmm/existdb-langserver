/**
 * Shared types used by LanguageService implementations.
 */

export interface Import {
	prefix: string;
	uri: string;
	source?: string;
	isJava?: boolean;
}

export interface Symbol {
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
 * A locally-parsed function/variable reference at the cursor — produced from
 * the REx parser AST by AnalyzedDocument.getSignatureFromPosition().
 *
 * v6 (atom-editor) uses this for hover / go-to-definition lookups: it sends
 * a "name#arity" string to the server and resolves imports client-side.
 *
 * v7 (existdb-openapi) doesn't need it — that path sends the full expression
 * plus a 0-indexed line/column and lets the server resolve everything.
 */
export interface ParsedSignature {
	name: string;
	arity: number;
}
