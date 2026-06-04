/**
 * Integration tests for the LanguageService strategy implementations.
 *
 * Runs against two live eXist containers:
 *  - V6_URI (default http://localhost:8092/exist) — eXist 6.0.0 with
 *    `atom-editor-support` + `shared-resources` XARs installed. Exercises
 *    the AtomEditorLanguageService.
 *  - V7_URI (default http://localhost:8091/exist) — eXist :latest with
 *    `existdb-openapi` (≥ #30) + `roaster` XARs installed. Exercises the
 *    OpenApiLanguageService.
 *
 * Skipped by default. Set INTEGRATION=1 to enable. Each container is
 * spun up by the developer running `docker run` per the README; this
 * spec doesn't manage them.
 */

import { strict as assert } from 'assert';
import { ServerSettings } from '../server/src/settings';
import { detectCapabilities } from '../server/src/services/capabilities';
import { OpenApiLanguageService } from '../server/src/services/openapi-language-service';
import { AtomEditorLanguageService } from '../server/src/services/atom-editor-language-service';

const skip = !process.env.INTEGRATION;
const V6_URI = process.env.V6_URI || 'http://localhost:8092/exist';
const V7_URI = process.env.V7_URI || 'http://localhost:8091/exist';

const v6Settings: ServerSettings = { uri: V6_URI, user: 'admin', password: '', path: '/db' };
const v7Settings: ServerSettings = { uri: V7_URI, user: 'admin', password: '', path: '/db' };

(skip ? describe.skip : describe)('Integration — capability detection', () => {
	it('detects v6 atom-editor against eXist 6.0.0', async () => {
		const caps = await detectCapabilities(v6Settings);
		assert.equal(caps.detection.kind, 'atom-editor');
		assert.equal(caps.languageService.label, 'atom-editor (v6)');
		assert.equal(caps.hasCursorExecution, false);
	});

	it('detects v7 openapi against eXist :latest + existdb-openapi', async () => {
		const caps = await detectCapabilities(v7Settings);
		assert.equal(caps.detection.kind, 'openapi');
		assert.equal(caps.languageService.label, 'existdb-openapi (v7+)');
	});

	it('classifies a bad URL as a network error (and still returns atom-editor as safe default)', async () => {
		const caps = await detectCapabilities({ ...v7Settings, uri: 'http://localhost:1/exist' });
		assert.equal(caps.detection.kind, 'error');
	});
});

(skip ? describe.skip : describe)('Integration — v6 AtomEditorLanguageService', () => {
	const svc = new AtomEditorLanguageService();

	it('diagnostics: returns a parse error for broken syntax', async () => {
		const diags = await svc.diagnostics('let $x := 1 return $x +', '/foo.xq', v6Settings);
		assert.ok(diags.length >= 1, `expected ≥ 1 diagnostic, got ${diags.length}`);
		assert.match(diags[0].message, /XPST0003|unexpected/i);
	});

	it('diagnostics: returns empty for valid expression', async () => {
		const diags = await svc.diagnostics('1 + 1', '/foo.xq', v6Settings);
		assert.equal(diags.length, 0);
	});
});

(skip ? describe.skip : describe)('Integration — v7 OpenApiLanguageService', () => {
	const svc = new OpenApiLanguageService();

	it('diagnostics: returns a parse error for broken syntax', async () => {
		const diags = await svc.diagnostics('declare function local:f(){1};\nbroken(', '/foo.xq', v7Settings);
		assert.ok(diags.length >= 1, `expected ≥ 1 diagnostic, got ${diags.length}`);
		assert.match(diags[0].message, /XPST0003|unexpected/i);
		// 0-indexed positions
		assert.equal(diags[0].range.start.line, 1, 'error on line 2 (0-indexed)');
	});

	it('diagnostics: empty for valid expression', async () => {
		const diags = await svc.diagnostics('1 + 1', '/foo.xq', v7Settings);
		assert.equal(diags.length, 0);
	});

	it('completions: returns a non-trivial list', async () => {
		const items = await svc.completions({
			text: 'count',
			prefix: 'count',
			imports: new Map(),
			relPath: '/foo.xq',
			settings: v7Settings
		});
		assert.ok(items.length > 0, `expected completions, got ${items.length}`);
	});

	it('hover: returns content for "count" function reference', async () => {
		const textDocument = {
			getText: () => 'count((1,2))',
			uri: 'file:///tmp/foo.xq'
		} as any;
		const result = await svc.hover({
			textDocument,
			position: { line: 0, character: 1 },
			signature: null,
			imports: new Map(),
			relPath: '/foo.xq',
			settings: v7Settings,
			uri: 'file:///tmp/foo.xq'
		});
		assert.ok(result, 'hover should return content');
		assert.match((result!.contents as any).value, /count/);
	});
});
