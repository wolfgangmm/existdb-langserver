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
	return axios.put(`${settings.uri}/apps/atom-editor/compile.xql`, text, {
		auth: {
			username: settings.user,
			password: settings.password
		},
		headers: {
			"X-BasePath": `${settings.path}/${relPath}`,
			"Content-Type": "application/octet-stream"
		},
		responseType: 'text'
	}).then(response => {
		if (response.status !== 200) {
			document.status(false, settings);
			return document;
		}
		document.status(true, settings);
		const json = JSON.parse(response.data);
		if (json.result !== 'pass') {
			const error = parseErrorMessage(json.error);
			if (!error.line) {
				document.status(false, settings);
				return document;
			} else {
				const diagnostic: Diagnostic = {
					severity: DiagnosticSeverity.Error,
					range: Range.create(error.line, error.column, error.line, error.column),
					message: error.msg,
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

function parseErrorMessage(error: any) {
	let msg;
	if (error.line) {
		msg = error["#text"];
	} else {
		msg = error;
	}

	let str = /.*line:?\s*(\d+),\s*column:?\s*(\d+)/i.exec(msg);
	let line = 0;
	let column = 0;
	if (str && str.length === 3) {
		line = parseInt(str[1]) - 1;
		column = parseInt(str[2]) - 1;
	} else {
		line = parseInt(error.line) - 1;
		column = parseInt(error.column) - 1;
	}

	return { line: Math.max(line, 0), column: Math.max(column, 0), msg: msg };
}

function xqlint(uri: String, text: String, document: AnalyzedDocument): void {
	// Build an AST for local symbol lookup (hover, go-to-definition).
	// Parse errors are intentionally ignored here — atom-editor's
	// compile.xql handles error checking on the server. We just need a
	// best-effort AST whenever the source is parseable.
	const result = rexParserAdapter.parseXQuery(text, XQueryParser);
	document.ast = result.ast;
}
