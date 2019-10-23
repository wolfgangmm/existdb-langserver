/**
 * Support for linting XQuery documents.
 * 
 * @author Wolfgang Meier
 */
import { Diagnostic, DiagnosticSeverity, Range, ResponseError, ErrorCodes } from 'vscode-languageserver';
import { XQLint } from 'xqlint';
import { ServerSettings } from './settings';
import { AnalyzedDocument } from './analyzed-document';
import * as request from 'request';

export function lintDocument(text: string, relPath: string, document: AnalyzedDocument, settings: ServerSettings): Promise<AnalyzedDocument | ResponseError<any>> {
	document.diagnostics = [];
	xqlint(document.uri, text, document);
	return serverLint(text, settings, relPath, document);
}

function serverLint(text: String, settings: ServerSettings, relPath: string, document: AnalyzedDocument): Promise<AnalyzedDocument | ResponseError<any>> {
	return new Promise(resolve => {
		const options = {
			uri: `${settings.uri}/apps/atom-editor/compile.xql`,
			method: "PUT",
			body: text,
			headers: {
				"X-BasePath": `${settings.path}/${relPath}`,
				"Content-Type": "application/octet-stream"
			},
			auth: {
				user: settings.user,
				password: settings.password,
				sendImmediately: true
			}
		};
		request(options, (error, response, body) => {
			if (error || response.statusCode !== 200) {
				resolve(document);
			} else {
				const json = JSON.parse(body);
				if (json.result !== 'pass') {
					const error = parseErrorMessage(json.error);
					const diagnostic: Diagnostic = {
						severity: DiagnosticSeverity.Error,
						range: Range.create(error.line, error.column, error.line, Number.MAX_VALUE),
						message: error.msg,
						source: 'xquery'
					};
					document.diagnostics.push(diagnostic);
				}
			}
			resolve(document);
		});
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

function xqlint(uri: String, text: String, document: AnalyzedDocument): Diagnostic[] {
	const xqlint = new XQLint(text, {
		fileName: uri
	});
	document.ast = xqlint.getAST();
	const warnings = xqlint.getWarnings();
	const diagnostics: Diagnostic[] = [];
	warnings.forEach(warning => {
		const diagnostic: Diagnostic = {
			severity: DiagnosticSeverity.Warning,
			range: Range.create(
				warning.pos.sl,
				warning.pos.sc,
				warning.pos.el,
				warning.pos.ec),
			message: warning.message,
			source: 'xquery'
		};
		diagnostics.push(diagnostic);
	});
	document.diagnostics = diagnostics;
	return diagnostics;
}