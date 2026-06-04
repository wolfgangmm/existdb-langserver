import * as vscode from 'vscode';

/**
 * Tracks an active cursor-based query result set
 */
export interface CursorState {
	cursor: string;
	hits: number;
	fetched: number;
	output: string;
	pageSize: number;
}

/**
 * Content provider for XQuery execution results.
 * Supports cursor-based paging: results can be appended as new pages are fetched.
 */
export default class QueryResultsProvider implements vscode.TextDocumentContentProvider {
	public results: string = '';

	public queryResultsUri = vscode.Uri.parse("xmldb-query://results");
	private changeEvent = new vscode.EventEmitter<vscode.Uri>();

	/** Active cursor state for paged results; null when using legacy execution */
	public cursorState: CursorState | null = null;

	public provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): string | Promise<string> {
		return this.results;
	}

	get onDidChange(): vscode.Event<vscode.Uri> {
		return this.changeEvent.event;
	}

	public update(results: string) {
		this.results = results;
		this.changeEvent.fire(this.queryResultsUri);
	}

	/**
	 * Append a new page of results to existing content.
	 */
	public appendResults(page: string) {
		this.results += page;
		this.changeEvent.fire(this.queryResultsUri);
	}

	public clearCursor() {
		this.cursorState = null;
	}
}
