/**
 * Strategy interface for executing user-issued XQuery queries (the
 * "Execute Query" command in the extension).
 *
 * Two implementations:
 *
 *  - AtomEditorQueryExecutor — POSTs form-encoded params to
 *    `/apps/atom-editor/execute`. Returns the full result body as a
 *    string in one shot. Used on v6.
 *  - OpenApiQueryExecutor — POSTs JSON to `/api/query` which opens a
 *    server-side cursor; results are fetched in pages via
 *    `/api/query/{id}/results` and the cursor is closed via
 *    `DELETE /api/query/{id}`. Used on v7+ when capabilities report
 *    `cursor.available === true`.
 */

import { ServerSettings } from '../settings';

export interface QueryResult {
	output: string;       // serialization method ("adaptive" | "xml" | "json" | "text")
	hits: string | number | undefined;  // total result count from the server (string for backwards compat)
	elapsed: string | undefined;
	results: any;
	cursor?: string;      // present on v7 cursor-based; absent on v6
	page?: { start: number; count: number };  // first page bounds on v7
}

export interface QueryExecutorOptions {
	method?: string;        // serialization method ("adaptive" | "xml" | "json" | "text")
	indent?: boolean;
	'highlight-matches'?: string;
}

export interface QueryExecutor {
	readonly label: string;

	/** Execute a query and return the first page of results (or all results on v6). */
	execute(query: string, settings: ServerSettings, relPath: string, options?: QueryExecutorOptions): Promise<QueryResult>;

	/** v7-only: fetch the next page from an open cursor. v6 just returns null. */
	fetchPage?(cursor: string, start: number, count: number, settings: ServerSettings, options?: QueryExecutorOptions): Promise<QueryResult | null>;

	/** v7-only: close a cursor. v6 no-ops. */
	closeCursor?(cursor: string, settings: ServerSettings): Promise<void>;
}
