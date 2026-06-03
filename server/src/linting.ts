/**
 * Support for linting XQuery documents.
 *
 * @author Wolfgang Meier
 */
import { Diagnostic, DiagnosticSeverity, Range, ResponseError, ErrorCodes } from 'vscode-languageserver';
import { ServerSettings } from './settings';
import { AnalyzedDocument } from './analyzed-document';
import axios from 'axios';

// eXide's REx-generated XQuery 3.1 parser + adapter that emits an AST shape
// compatible with what xqlint's JSONParseTreeHandler used to produce. The
// langserver only needs local symbol lookup (used by hover / go-to-definition
// when a server roundtrip isn't worth it); the adapter's normalized AST is
// what server/src/ast.ts traverses.
//
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XQueryParser = require('./parser/XQueryParser');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rexParserAdapter = require('./parser/adapter');

export function lintDocument(text: string, relPath: string, document: AnalyzedDocument, settings: ServerSettings): Promise<AnalyzedDocument | ResponseError<any>> {
	document.diagnostics = [];
	if (text.length == 0) {
		return Promise.resolve(document);
	}
	try {
		xqlint(document.uri, text, document);
	} catch (e) {
		// ignore
	}
	return serverLint(text, settings, relPath, document);

}

function serverLint(text: String, settings: ServerSettings, relPath: string, document: AnalyzedDocument): Promise<AnalyzedDocument | ResponseError<any>> {
	return axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/diagnostics`, {
		expression: text,
		"module-load-path": `${settings.path}/${relPath}`
	}, {
		auth: {
			username: settings.user,
			password: settings.password
		},
		headers: {
			"Content-Type": "application/json"
		},
		responseType: 'json'
	}).then(response => {
		if (response.status !== 200) {
			document.status(false, settings);
			return document;
		}
		document.status(true, settings);
		const diagnostics: any[] = response.data;
		if (Array.isArray(diagnostics)) {
			for (const d of diagnostics) {
				// existdb-openapi returns 0-indexed line/column, same as LSP — pass through.
				const line = Math.max(d.line || 0, 0);
				const column = Math.max(d.column || 0, 0);
			const diagnostic: Diagnostic = {
					severity: mapSeverity(d.severity),
					range: Range.create(line, column, line, column),
					message: d.message,
					code: d.code,
					source: 'xquery'
				};
				document.diagnostics.push(diagnostic);
			}
		}
		return document;
	}).catch(error => {
		document.status(false, settings);
		return document;
	});
}

function mapSeverity(severity: string | number): DiagnosticSeverity {
	if (typeof severity === 'number') {
		// LSP DiagnosticSeverity: 1=Error, 2=Warning, 3=Information, 4=Hint
		if (severity >= 1 && severity <= 4) {
			return severity as DiagnosticSeverity;
		}
		return DiagnosticSeverity.Error;
	}
	switch (severity) {
		case 'error': return DiagnosticSeverity.Error;
		case 'warning': return DiagnosticSeverity.Warning;
		case 'info': return DiagnosticSeverity.Information;
		case 'hint': return DiagnosticSeverity.Hint;
		default: return DiagnosticSeverity.Error;
	}
}

function xqlint(uri: String, text: String, document: AnalyzedDocument): void {
	// Build an AST for local symbol lookup (hover, go-to-definition).
	// Parse errors are intentionally ignored here — server-side
	// lang:diagnostics handles error checking. We just need a best-effort
	// AST whenever the source is parseable.
	const result = rexParserAdapter.parseXQuery(text, XQueryParser);
	document.ast = result.ast;
}
