/**
 * Capability detection + LanguageService factory.
 *
 * Runs once per workspace at connect time. Probes the connected server
 * for the existdb-openapi langservice endpoints and returns either the
 * v7 implementation (OpenApiLanguageService) or the v6 fallback
 * (AtomEditorLanguageService).
 *
 * Also exports a parallel detector for cursor-based query execution
 * (`hasCursorExecution`) — cursor:eval is a v7-only feature that the
 * Execute path lights up when available.
 *
 * All probes degrade gracefully: anything other than a clean 200 from
 * the openapi endpoint causes the v6 path to be selected. That covers
 * the realistic failure modes: openapi XAR not installed (404), older
 * eXist that doesn't ship openapi (connection succeeds but endpoint
 * missing), or transient network errors.
 */

import axios, { AxiosError } from 'axios';
import { ServerSettings } from '../settings';
import { LanguageService } from './language-service';
import { OpenApiLanguageService } from './openapi-language-service';
import { AtomEditorLanguageService } from './atom-editor-language-service';

export type DetectionOutcome =
	| { kind: 'openapi'; cursorAvailable: boolean }
	| { kind: 'atom-editor' }
	| { kind: 'error'; reason: string; status?: number };

export interface ServerCapabilities {
	languageService: LanguageService;
	hasCursorExecution: boolean;
	detection: DetectionOutcome;
}

export interface CapabilityProbeResult {
	openapi: boolean;
	cursor: boolean;
	httpStatus?: number;
	error?: { kind: 'network' | 'auth' | 'other'; message: string };
}

/**
 * Probe the server for existdb-openapi presence.
 *
 *  - Tries `GET /apps/existdb-openapi/api/langservice/capabilities`.
 *  - 200 with `{cursor: {available: true|false}}` → openapi present.
 *  - 401 → auth failure (returned separately so the caller can surface
 *    a meaningful "check your credentials" warning rather than silently
 *    falling back to v6 with bad credentials).
 *  - Anything else (404, ECONNREFUSED, timeout) → treat as "openapi not
 *    present" and let the caller fall back to atom-editor.
 */
export async function probeOpenApi(settings: ServerSettings): Promise<CapabilityProbeResult> {
	try {
		const response = await axios.get(`${settings.uri}/apps/existdb-openapi/api/langservice/capabilities`, {
			auth: { username: settings.user, password: settings.password },
			responseType: 'json',
			validateStatus: () => true
		});
		if (response.status === 200 && response.data && response.data.cursor) {
			return {
				openapi: true,
				cursor: response.data.cursor.available === true,
				httpStatus: 200
			};
		}
		if (response.status === 401) {
			return {
				openapi: false,
				cursor: false,
				httpStatus: 401,
				error: { kind: 'auth', message: 'Authentication failed — check user/password in settings' }
			};
		}
		return { openapi: false, cursor: false, httpStatus: response.status };
	} catch (e) {
		const ax = e as AxiosError;
		const message = ax.message || String(e);
		// ECONNREFUSED / ENOTFOUND / timeout → network class.
		const isNetwork = /ECONN|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH/.test(message);
		return {
			openapi: false,
			cursor: false,
			error: { kind: isNetwork ? 'network' : 'other', message }
		};
	}
}

/**
 * Build the LanguageService for this workspace based on probe results.
 *
 * If openapi is available, use the v7 implementation. Otherwise fall
 * back to atom-editor. Auth/network errors do *not* fall back silently
 * — the caller is expected to inspect `detection.kind === 'error'` and
 * surface a warning before attempting any actual operations.
 */
export function selectLanguageService(
	probe: CapabilityProbeResult,
	logger: (message: string, prio?: string) => void = () => {}
): ServerCapabilities {
	if (probe.error) {
		// Even on error, pick atom-editor so the editor doesn't crash on
		// subsequent calls — but record the error in `detection` so the
		// caller can warn the user.
		return {
			languageService: new AtomEditorLanguageService(logger),
			hasCursorExecution: false,
			detection: { kind: 'error', reason: probe.error.message, status: probe.httpStatus }
		};
	}
	if (probe.openapi) {
		return {
			languageService: new OpenApiLanguageService(logger),
			hasCursorExecution: probe.cursor,
			detection: { kind: 'openapi', cursorAvailable: probe.cursor }
		};
	}
	return {
		languageService: new AtomEditorLanguageService(logger),
		hasCursorExecution: false,
		detection: { kind: 'atom-editor' }
	};
}

/**
 * Convenience wrapper: probe + select in one call.
 */
export async function detectCapabilities(
	settings: ServerSettings,
	logger: (message: string, prio?: string) => void = () => {}
): Promise<ServerCapabilities> {
	const probe = await probeOpenApi(settings);
	return selectLanguageService(probe, logger);
}
