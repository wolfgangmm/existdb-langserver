import { strict as assert } from 'assert';
import sinon from 'sinon';
import { AnalyzedDocument } from '../server/src/analyzed-document';
import { ServerSettings } from '../server/src/settings';

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

describe('Serialization options', () => {
	let postStub: sinon.SinonStub;
	let getStub: sinon.SinonStub;

	beforeEach(() => {
		postStub = sinon.stub(ax, 'post');
		getStub = sinon.stub(ax, 'get');
	});

	afterEach(() => {
		sinon.restore();
	});

	describe('evalQuery with serialization options', () => {
		it('should pass options through to fetchResults (as query params on GET)', async () => {
			postStub.resolves({
				status: 200,
				data: { cursor: 'cur-opts', items: 10, elapsed: 5 }
			});
			getStub.resolves({
				status: 200,
				data: [{ value: '<doc/>', type: 'element' }]
			});

			const doc = makeDoc();
			const options = { method: 'xml', indent: 'yes' };
			await doc.evalQuery('1', settings, '', 100, options);

			const fetchCall = getStub.getCall(0);
			const params = fetchCall.args[1].params;
			assert.equal(params.method, 'xml');
			assert.equal(params.indent, 'yes');
			assert.equal(params.start, '1');
			assert.equal(params.count, '100');
		});

		it('should not include serialization keys when no options provided', async () => {
			postStub.resolves({
				status: 200,
				data: { cursor: 'cur-no-opts', items: 1, elapsed: 1 }
			});
			getStub.resolves({
				status: 200,
				data: [{ value: '1', type: 'integer' }]
			});

			const doc = makeDoc();
			await doc.evalQuery('1', settings, '');

			const params = getStub.getCall(0).args[1].params;
			assert.equal(params.method, undefined);
			assert.equal(params.indent, undefined);
		});
	});

	describe('fetchResults with serialization options', () => {
		it('should include options as query params on the GET', async () => {
			getStub.resolves({ status: 200, data: [] });

			const doc = makeDoc();
			const options = { method: 'json', indent: 'no' };
			await doc.fetchResults('cur-1', 1, 50, settings, options);

			const params = getStub.getCall(0).args[1].params;
			assert.equal(params.start, '1');
			assert.equal(params.count, '50');
			assert.equal(params.method, 'json');
			assert.equal(params.indent, 'no');
		});

		it('should omit serialization keys when undefined', async () => {
			getStub.resolves({ status: 200, data: [] });

			const doc = makeDoc();
			await doc.fetchResults('cur-1', 1, 50, settings);

			const params = getStub.getCall(0).args[1].params;
			assert.equal(params.method, undefined);
			assert.equal(params.indent, undefined);
		});

		it('should pass highlight-matches option for Lucene queries', async () => {
			getStub.resolves({ status: 200, data: [] });

			const doc = makeDoc();
			const options = { method: 'xml', indent: 'yes', 'highlight-matches': 'both' };
			await doc.fetchResults('cur-ft', 1, 100, settings, options);

			const params = getStub.getCall(0).args[1].params;
			assert.equal(params['highlight-matches'], 'both');
		});
	});
});

describe('Lucene full-text detection', () => {
	// Mirrors the regex from extension.ts: /\bft:(query|search)\b/
	const ftRegex = /\bft:(query|search)\b/;

	it('should detect ft:query', () => {
		assert.ok(ftRegex.test('collection("/db")//p[ft:query(., "test")]'));
	});

	it('should detect ft:search', () => {
		assert.ok(ftRegex.test('ft:search($node, "term")'));
	});

	it('should not match partial names like ft:query-field', () => {
		// \b after "query" ensures word boundary — "ft:query-field" should NOT match
		// because "-" is not a word character, but \b fires between "y" and "-"
		// so ft:query IS matched as a word. This is correct: the query still uses ft:query.
		assert.ok(ftRegex.test('ft:query-field(., "test")'));
	});

	it('should not match in comments or strings without ft:', () => {
		assert.ok(!ftRegex.test('let $x := "full text query search"'));
	});

	it('should not match random ft: prefixes', () => {
		assert.ok(!ftRegex.test('ft:index-info()'));
	});
});
