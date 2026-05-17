import { strict as assert } from 'assert';
import sinon from 'sinon';
import { AnalyzedDocument } from '../server/src/analyzed-document';
import { ServerSettings } from '../server/src/settings';

// Get the exact same axios instance that AnalyzedDocument uses
// (resolved from server/src/ → server/node_modules/axios/dist/node/axios.cjs)
const serverAxiosPath = require.resolve('axios', { paths: [__dirname + '/../server/src'] });
const axios = require(serverAxiosPath);
const ax = axios.default || axios;

const settings: ServerSettings = {
	uri: 'http://localhost:8080/exist',
	user: 'admin',
	password: '',
	path: '/db/apps/test'
};

const noop = () => {};

function makeDoc(): AnalyzedDocument {
	return new AnalyzedDocument('file:///test.xq', null, noop, noop);
}

describe('Cursor-based execution (AnalyzedDocument)', () => {
	let postStub: sinon.SinonStub;
	let getStub: sinon.SinonStub;
	let deleteStub: sinon.SinonStub;

	beforeEach(() => {
		postStub = sinon.stub(ax, 'post');
		getStub = sinon.stub(ax, 'get');
		deleteStub = sinon.stub(ax, 'delete');
	});

	afterEach(() => {
		sinon.restore();
	});

	describe('evalQuery', () => {
		it('should POST /api/query then GET /api/query/{id}/results for the first page', async () => {
			postStub.resolves({
				status: 200,
				data: { cursor: 'cur-123', items: 250, elapsed: 42 }
			});
			getStub.resolves({
				status: 200,
				data: [
					{ value: '<item>1</item>', type: 'element' },
					{ value: '<item>2</item>', type: 'element' }
				]
			});

			const doc = makeDoc();
			const result = await doc.evalQuery('for $x in 1 to 250 return <item>{$x}</item>', settings, 'modules');

			assert.equal(postStub.callCount, 1);
			const evalCall = postStub.getCall(0);
			assert.ok(evalCall.args[0].endsWith('/apps/existdb-openapi/api/query'));
			assert.deepEqual(evalCall.args[1], {
				query: 'for $x in 1 to 250 return <item>{$x}</item>',
				"module-load-path": '/db/apps/test/modules'
			});

			assert.equal(getStub.callCount, 1);
			const fetchCall = getStub.getCall(0);
			assert.ok(fetchCall.args[0].endsWith('/apps/existdb-openapi/api/query/cur-123/results'));
			assert.deepEqual(fetchCall.args[1].params, { start: '1', count: '100' });

			assert.equal(result.cursor, 'cur-123');
			assert.equal(result.hits, 250);
			assert.equal(result.elapsed, 42);
			assert.equal(result.output, 'adaptive');
			assert.equal(result.results.length, 2);
		});

		it('should detect output mode from query', async () => {
			postStub.resolves({
				status: 200,
				data: { cursor: 'cur-456', items: 1, elapsed: 5 }
			});
			getStub.resolves({
				status: 200,
				data: [{ value: '{"key": "val"}', type: 'string' }]
			});

			const doc = makeDoc();
			const query = 'declare option output:method "json"; map { "key": "val" }';
			const result = await doc.evalQuery(query, settings, '');

			assert.equal(result.output, 'json');
		});

		it('should use custom page size', async () => {
			postStub.resolves({
				status: 200,
				data: { cursor: 'cur-789', items: 500, elapsed: 10 }
			});
			getStub.resolves({ status: 200, data: [] });

			const doc = makeDoc();
			await doc.evalQuery('1', settings, '', 50);

			const fetchCall = getStub.getCall(0);
			assert.equal(fetchCall.args[1].params.count, '50');
		});

		it('should propagate eval endpoint errors', async () => {
			postStub.rejects(new Error('Connection refused'));

			const doc = makeDoc();
			await assert.rejects(
				() => doc.evalQuery('1', settings, ''),
				/Connection refused/
			);
		});
	});

	describe('fetchResults', () => {
		it('should GET /api/query/{id}/results with start+count as query params', async () => {
			getStub.resolves({
				status: 200,
				data: [
					{ value: 'a', type: 'string' },
					{ value: 'b', type: 'string' }
				]
			});

			const doc = makeDoc();
			const items = await doc.fetchResults('cur-abc', 101, 50, settings);

			const call = getStub.getCall(0);
			assert.ok(call.args[0].endsWith('/apps/existdb-openapi/api/query/cur-abc/results'));
			assert.deepEqual(call.args[1].params, { start: '101', count: '50' });
			assert.equal(items.length, 2);
			assert.equal(items[0].value, 'a');
		});

		it('should return empty array when no more results', async () => {
			getStub.resolves({ status: 200, data: [] });

			const doc = makeDoc();
			const items = await doc.fetchResults('cur-done', 500, 100, settings);

			assert.deepEqual(items, []);
		});
	});

	describe('closeCursor', () => {
		it('should DELETE /api/query/{id} and return true when closed', async () => {
			deleteStub.resolves({ status: 200, data: { closed: true } });

			const doc = makeDoc();
			const result = await doc.closeCursor('cur-close', settings);

			const call = deleteStub.getCall(0);
			assert.ok(call.args[0].endsWith('/apps/existdb-openapi/api/query/cur-close'));
			assert.equal(result, true);
		});

		it('should return false when server reports cursor not closed', async () => {
			deleteStub.resolves({ status: 200, data: { closed: false } });

			const doc = makeDoc();
			const result = await doc.closeCursor('cur-unknown', settings);

			assert.equal(result, false);
		});
	});

	describe('executeQuery (legacy 6.x fallback via atom-editor)', () => {
		it('should POST to atom-editor/execute endpoint', async () => {
			postStub.resolves({
				status: 200,
				headers: {
					'x-result-count': '3',
					'x-elapsed': '15'
				},
				data: '<results><item/><item/><item/></results>'
			});

			const doc = makeDoc();
			const result = await doc.executeQuery(
				'for $x in 1 to 3 return <item/>',
				settings,
				'modules'
			);

			const call = postStub.getCall(0);
			assert.ok(call.args[0].endsWith('/apps/atom-editor/execute'));
			const body = call.args[1];
			assert.ok(body.includes('qu='));
			assert.ok(body.includes('count=100'));

			assert.equal(result.hits, '3');
			assert.equal(result.elapsed, '15');
			assert.equal(result.output, 'adaptive');
			assert.ok(result.results.includes('<results>'));
		});
	});
});
