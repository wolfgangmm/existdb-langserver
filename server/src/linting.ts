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
	return axios.post(`${settings.uri}/apps/existdb-openapi/api/langservice/diagnostics`, {
		query: text,
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
				// lang:diagnostics returns 1-indexed lines; LSP protocol uses 0-indexed
			const line = Math.max(d.line - 1, 0);
			const column = Math.max(d.column - 1, 0);
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
	const xqlint = new XQLint(text, {
		fileName: uri
	});
	// Keep AST for local symbol lookup (hover, go-to-definition).
	// Skip getWarnings() — server-side lang:diagnostics handles error
	// checking without the false positives xqlint produces (e.g. #67).
	document.ast = xqlint.getAST();
}
