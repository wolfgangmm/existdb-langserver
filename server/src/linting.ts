/**
 * Support for linting XQuery documents.
 * 
 * @author Wolfgang Meier
 */
import { Diagnostic, DiagnosticSeverity, Range, ResponseError, ErrorCodes } from 'vscode-languageserver';
import { XQLint } from 'xqlint';
import { ServerSettings } from './settings';
import { AnalyzedDocument } from './analyzed-document';
import axios from 'axios';

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

function xqlint(uri: String, text: String, document: AnalyzedDocument): Diagnostic[] {
	const xqlint = new XQLint(text, {
		fileName: uri
	});
	document.ast = xqlint.getAST();
	const warnings:any[] = xqlint.getWarnings();
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