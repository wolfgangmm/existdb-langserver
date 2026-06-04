/**
 * v6 query executor. POSTs form-encoded params to the atom-editor
 * `/execute` endpoint and returns the whole result body in one shot.
 * Preserved unchanged from master — only the wrapping changed.
 */

import axios from 'axios';
import { ServerSettings } from '../settings';
import { QueryExecutor, QueryExecutorOptions, QueryResult } from './query-executor';

const ATOM_EDITOR_EXECUTE = '/apps/atom-editor/execute';

export class AtomEditorQueryExecutor implements QueryExecutor {
	readonly label = 'atom-editor (v6)';

	constructor(private readonly logger: (message: string, prio?: string) => void = () => {}) {}

	async execute(query: string, settings: ServerSettings, relPath: string, _options?: QueryExecutorOptions): Promise<QueryResult> {
		const params = {
			output: detectOutputMode(query),
			qu: query,
			count: '100',
			base: `${settings.path}/${relPath}`
		};
		this.logger(`Execute query (v6) with output mode: ${params.output}, path: ${params.base}`);
		const response = await axios.post(`${settings.uri}${ATOM_EDITOR_EXECUTE}`, new URLSearchParams(params).toString(), {
			auth: { username: settings.user, password: settings.password },
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			responseType: 'text'
		});
		return {
			output: params.output,
			hits: response.headers['x-result-count'],
			elapsed: response.headers['x-elapsed'],
			results: response.data
		};
	}
}

function detectOutputMode(content: string): string {
	const match = /declare\s+option.*:method\s+"(.*)"\s*;/.exec(content);
	if (match) return match[1];
	return 'adaptive';
}
