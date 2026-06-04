/**
 * Linting / diagnostics for XQuery documents.
 *
 * Two things happen on every change:
 *
 *  1. Local parse via eXide's REx-generated XQuery 3.1 parser — produces
 *     an AST stored on the document for fast cursor-position lookups
 *     (hover, go-to-definition). Parse errors here are swallowed; the
 *     server-side diagnostics call below is the source of truth.
 *  2. Remote diagnostics call via the active LanguageService strategy
 *     — atom-editor's `compile.xql` on v6, openapi's `/api/langservice/
 *     diagnostics` on v7. The two return different things (single error
 *     from `util:compile-query` on v6, structured multi-error JSON on v7);
 *     both shapes are normalized into Diagnostic[] inside the service.
 *
 * @author Wolfgang Meier (original, atom-editor path); refactored to
 * route diagnostics through the LanguageService strategy.
 */

import { ResponseError } from 'vscode-languageserver';
import { ServerSettings } from './settings';
import { AnalyzedDocument } from './analyzed-document';

// eXide's REx-generated XQuery 3.1 parser + adapter — see
// services/atom-editor-language-service.ts and the comment in
// server/src/parser/adapter.js for the full story.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XQueryParser = require('./parser/XQueryParser');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rexParserAdapter = require('./parser/adapter');

export async function lintDocument(text: string, relPath: string, document: AnalyzedDocument, settings: ServerSettings): Promise<AnalyzedDocument | ResponseError<any>> {
	document.diagnostics = [];
	if (text.length === 0) {
		return document;
	}
	try {
		buildLocalAst(text, document);
	} catch (e) {
		// ignore parse errors — server-side diagnostics handle reporting
	}
	if (!document.service) {
		// No remote available yet (capability detection in flight, or
		// connection failed); return what local analysis produced.
		return document;
	}
	try {
		const diagnostics = await document.service.diagnostics(text, relPath, settings);
		document.diagnostics = diagnostics;
		document.status(true, settings);
	} catch (e) {
		document.status(false, settings);
	}
	return document;
}

function buildLocalAst(text: string, document: AnalyzedDocument): void {
	const result = rexParserAdapter.parseXQuery(text, XQueryParser);
	document.ast = result.ast;
}
