/**
 * v7+ query executor using existdb-openapi's cursor-based query API:
 *
 *  - `POST /api/query` opens a cursor (server-side `cursor:eval`),
 *    returns first page + cursor id.
 *  - `GET /api/query/{id}/results?start=…&count=…` fetches more pages
 *    (server-side `cursor:fetch`).
 *  - `DELETE /api/query/{id}` closes the cursor (server-side
 *    `cursor:close`) and frees resources.
 *
 * The extension's "Load More Results" command and pagination UI go
 * through fetchPage()/closeCursor(); on a v6 server these are absent
 * (the QueryExecutor interface marks them optional) and the extension's
 * client-side check disables the load-more affordance.
 */

import axios from 'axios';
import { ServerSettings } from '../settings';
import { QueryExecutor, QueryExecutorOptions, QueryResult } from './query-executor';

const OPENAPI_QUERY = '/apps/existdb-openapi/api/query';

export class OpenApiQueryExecutor implements QueryExecutor {
	readonly label = 'existdb-openapi cursor (v7+)';

	constructor(private readonly logger: (message: string, prio?: string) => void = () => {}) {}

	async execute(query: string, settings: ServerSettings, relPath: string, options?: QueryExecutorOptions): Promise<QueryResult> {
		const method = options?.method || detectOutputMode(query);
		this.logger(`Execute query (v7 cursor) with method: ${method}, path: ${settings.path}/${relPath}`);

		const evalResponse = await axios.post(`${settings.uri}${OPENAPI_QUERY}`, {
			query,
			'base-uri': `${settings.path}/${relPath}`
		}, {
			auth: { username: settings.user, password: settings.password },
			headers: { 'Content-Type': 'application/json' },
			responseType: 'json'
		});
		const cursor = evalResponse.data?.cursor;
		const total = evalResponse.data?.items;
		const elapsed = evalResponse.data?.elapsed;

		if (!cursor) {
			// Older openapi version without cursor — pre-resolved results.
			return {
				output: method,
				hits: total,
				elapsed,
				results: evalResponse.data?.results ?? ''
			};
		}

		// Fetch first page right away so the executor matches v6's "results on return".
		const firstPage = await this.fetchPageRaw(cursor, 0, 100, settings, { method, ...options });
		return {
			output: method,
			hits: total,
			elapsed,
			results: firstPage,
			cursor,
			page: { start: 0, count: 100 }
		};
	}

	async fetchPage(cursor: string, start: number, count: number, settings: ServerSettings, options?: QueryExecutorOptions): Promise<QueryResult | null> {
		const results = await this.fetchPageRaw(cursor, start, count, settings, options);
		return {
			output: options?.method || 'adaptive',
			hits: undefined,
			elapsed: undefined,
			results,
			cursor,
			page: { start, count }
		};
	}

	async closeCursor(cursor: string, settings: ServerSettings): Promise<void> {
		try {
			await axios.delete(`${settings.uri}${OPENAPI_QUERY}/${encodeURIComponent(cursor)}`, {
				auth: { username: settings.user, password: settings.password },
				validateStatus: () => true
			});
		} catch (e) {
			// Best-effort close.
		}
	}

	private async fetchPageRaw(cursor: string, start: number, count: number, settings: ServerSettings, options?: QueryExecutorOptions): Promise<any> {
		const params: any = { start, count };
		if (options?.method) params.method = options.method;
		if (options?.indent != null) params.indent = options.indent;
		if (options?.['highlight-matches']) params['highlight-matches'] = options['highlight-matches'];

		const response = await axios.get(`${settings.uri}${OPENAPI_QUERY}/${encodeURIComponent(cursor)}/results`, {
			auth: { username: settings.user, password: settings.password },
			params,
			responseType: 'text'
		});
		return response.data;
	}
}

function detectOutputMode(content: string): string {
	const match = /declare\s+option.*:method\s+"(.*)"\s*;/.exec(content);
	if (match) return match[1];
	return 'adaptive';
}
