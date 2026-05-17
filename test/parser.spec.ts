/**
 * Tests for the local XQuery 3.1 parser + AST traversal used for hover and
 * go-to-definition when a server roundtrip isn't worth it.
 *
 * Covers the chain:
 *   rexParserAdapter.parseXQuery(text, XQueryParser).ast
 *     → server/src/ast.ts findNode / getAncestorOrSelf / getFunctionSignature
 *
 * The langserver uses this AST only for locating the FunctionCall under
 * the cursor. Diagnostics + completions + everything else go to the
 * server-side langservice endpoints.
 */
import { strict as assert } from 'assert';
import { AST } from '../server/src/ast';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const XQueryParser = require('../server/src/parser/XQueryParser');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rexParserAdapter = require('../server/src/parser/adapter');

function parse(text: string) {
	return rexParserAdapter.parseXQuery(text, XQueryParser);
}

describe('XQuery 3.1 parser (eXide REx adapter)', () => {
	describe('parseXQuery', () => {
		it('parses a trivial expression without error', () => {
			const { ast, error } = parse('1 + 1');
			assert.equal(error, null);
			assert.equal(ast.name, 'XQuery');
			assert.ok(ast.children.length > 0);
		});

		it('parses a module with a function declaration and a call', () => {
			const { ast, error } = parse(
				'declare function local:foo($x as xs:integer) as xs:integer { $x + 1 }; local:foo(42)'
			);
			assert.equal(error, null);
			assert.equal(ast.name, 'XQuery');
		});

		it('returns an error object (non-null) for invalid syntax without throwing', () => {
			const { ast, error } = parse('let $x := return $x');
			assert.notEqual(error, null, 'parser should report an error');
			assert.ok(ast, 'a partial AST should still be returned');
		});

		it('parses XQuery 3.1 features (FLWOR, type declarations, namespaces)', () => {
			const { ast, error } = parse(`xquery version "3.1";
declare namespace ex = "http://example.com";
declare function ex:greet($name as xs:string) as xs:string {
  "Hello, " || $name
};
for $n in ("Alice", "Bob")
return ex:greet($n)`);
			assert.equal(error, null);
		});
	});

	describe('AST.findNode + getAncestorOrSelf("FunctionCall") + getFunctionSignature', () => {
		it('identifies the function call under the cursor', () => {
			const text = 'declare function local:foo($x) { $x + 1 }; local:foo(42)';
			const callOffset = text.indexOf('local:foo(42)');
			const { ast } = parse(text);

			// Cursor on the "f" of local:foo(42)
			const pos = { line: 0, character: callOffset + 6 };
			const node = AST.findNode(ast, pos);
			assert.ok(node, 'findNode should return a node');

			const fcall = AST.getAncestorOrSelf('FunctionCall', node);
			assert.ok(fcall, 'should find FunctionCall ancestor');

			const sig = AST.getFunctionSignature(fcall);
			assert.ok(sig);
			assert.equal(sig.name, 'local:foo');
			assert.equal(sig.arity, 1);
		});

		it('distinguishes calls by arity', () => {
			const text = 'declare function local:f($a) { 1 }; declare function local:f($a, $b) { 2 }; local:f(1, 2)';
			const callOffset = text.indexOf('local:f(1, 2)');
			const { ast } = parse(text);

			const pos = { line: 0, character: callOffset + 4 };
			const node = AST.findNode(ast, pos);
			const fcall = AST.getAncestorOrSelf('FunctionCall', node);
			const sig = AST.getFunctionSignature(fcall);

			assert.equal(sig.name, 'local:f');
			assert.equal(sig.arity, 2);
		});

		it('returns null when the cursor is not on a FunctionCall', () => {
			const text = 'let $x := 1 return $x + 1';
			const { ast } = parse(text);

			// Cursor on '1' in 'let $x := 1'
			const pos = { line: 0, character: 10 };
			const node = AST.findNode(ast, pos);
			assert.ok(node, 'findNode should return some node');
			const fcall = AST.getAncestorOrSelf('FunctionCall', node);
			assert.equal(fcall, null, 'no FunctionCall ancestor for a literal');
		});

		it('handles multi-line input — positions resolve correctly across lines', () => {
			const text = 'declare function local:double($n) { $n * 2 };\nlocal:double(21)';
			const { ast } = parse(text);

			// Cursor on "double" of the call on line 1
			// "local:double(21)" — the call starts at column 0 on line 1
			const pos = { line: 1, character: 8 };
			const node = AST.findNode(ast, pos);
			const fcall = AST.getAncestorOrSelf('FunctionCall', node);
			const sig = AST.getFunctionSignature(fcall);

			assert.ok(sig);
			assert.equal(sig.name, 'local:double');
			assert.equal(sig.arity, 1);
		});
	});
});
