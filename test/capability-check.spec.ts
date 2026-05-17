import { strict as assert } from 'assert';
import sinon from 'sinon';
import axios from 'axios';
import { ServerSettings } from '../server/src/settings';

// Get the exact same axios instance that AnalyzedDocument uses
const serverAxiosPath = require.resolve('axios', { paths: [__dirname + '/../server/src'] });
const serverAxios = require(serverAxiosPath);

const settings: ServerSettings = {
	uri: 'http://localhost:8080/exist',
	user: 'admin',
	password: '',
	path: '/db/apps/test'
};

// Extracted capability check logic (mirrors server.ts implementation).
// Reads /api/langservice/capabilities and returns true iff cursor support
// is advertised. Replaces the previous probe-hack (sending a dummy eval
// and inspecting the response for a cursor field).
async function checkLspEvalCapability(s: ServerSettings): Promise<boolean> {
	try {
		const response = await axios.get(`${s.uri}/apps/existdb-openapi/api/langservice/capabilities`, {
			auth: { username: s.user, password: s.password },
			responseType: 'json'
		});
		if (response.status === 200 && response.data && response.data.cursor) {
			return response.data.cursor.available === true;
		}
	} catch (_) {
		// endpoint not available; legacy execution path will be used
	}
	return false;
}

describe('cursor:eval capability detection', () => {
	let getStub: sinon.SinonStub;

	beforeEach(() => {
		getStub = sinon.stub(axios, 'get');
	});

	afterEach(() => {
		sinon.restore();
	});

	it('should return true when capabilities endpoint advertises cursor support', async () => {
		getStub.resolves({
			status: 200,
			data: {
				cursor: { available: true },
				diagnostics: { available: true, provider: 'exist-xquery-parser' }
			}
		});

		const result = await checkLspEvalCapability(settings);

		assert.equal(result, true);
		assert.equal(getStub.callCount, 1);
		const url = getStub.getCall(0).args[0];
		assert.ok(url.endsWith('/apps/existdb-openapi/api/langservice/capabilities'));
	});

	it('should return false when capabilities endpoint is not available (404)', async () => {
		getStub.rejects({ response: { status: 404 } });

		const result = await checkLspEvalCapability(settings);

		assert.equal(result, false);
	});

	it('should return false when server is unreachable', async () => {
		getStub.rejects(new Error('ECONNREFUSED'));

		const result = await checkLspEvalCapability(settings);

		assert.equal(result, false);
	});

	it('should return false when capabilities response is missing cursor block', async () => {
		getStub.resolves({
			status: 200,
			data: { diagnostics: { available: true } }
		});

		const result = await checkLspEvalCapability(settings);

		assert.equal(result, false);
	});

	it('should return false when cursor block is present but available=false', async () => {
		getStub.resolves({
			status: 200,
			data: { cursor: { available: false } }
		});

		const result = await checkLspEvalCapability(settings);

		assert.equal(result, false);
	});
});

describe('Command routing based on hasLspEval', () => {
	let postStub: sinon.SinonStub;
	let getStub: sinon.SinonStub;

	beforeEach(() => {
		postStub = sinon.stub(serverAxios.default || serverAxios, 'post');
		getStub = sinon.stub(serverAxios.default || serverAxios, 'get');
	});

	afterEach(() => {
		sinon.restore();
	});

	it('should use evalQuery when cursor:eval is available (POST /api/query)', async () => {
		const { AnalyzedDocument } = await import('../server/src/analyzed-document');
		const doc = new AnalyzedDocument('file:///test.xq', null, () => {}, () => {});

		postStub.resolves({
			status: 200,
			data: { cursor: 'cur-1', items: 5, elapsed: 10 }
		});
		getStub.resolves({
			status: 200,
			data: [{ value: '1', type: 'integer' }]
		});

		const result = await doc.evalQuery('1 to 5', settings, '');

		assert.ok(result.cursor, 'should have cursor in response');
		assert.equal(result.hits, 5);
		const evalUrl = postStub.getCall(0).args[0];
		assert.ok(evalUrl.endsWith('/apps/existdb-openapi/api/query'));
		assert.ok(!evalUrl.includes('atom-editor'));
	});

	it('should use legacy executeQuery (POST /apps/atom-editor/execute) when cursor:eval is not available', async () => {
		const { AnalyzedDocument } = await import('../server/src/analyzed-document');
		const doc = new AnalyzedDocument('file:///test.xq', null, () => {}, () => {});

		postStub.resolves({
			status: 200,
			headers: { 'x-result-count': '5', 'x-elapsed': '10' },
			data: '1\n2\n3\n4\n5'
		});

		const result = await doc.executeQuery('1 to 5', settings, '');

		assert.ok(!result.cursor, 'legacy path should not have cursor');
		assert.equal(result.hits, '5');
		const url = postStub.getCall(0).args[0];
		assert.ok(url.includes('/apps/atom-editor/execute'));
	});
});
