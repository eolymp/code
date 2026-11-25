const assert = require('node:assert/strict');
const { test } = require('node:test');
const api = require('../../eolymp/api');

test('a problem link gives the problem number', () => {
  assert.equal(api.numberIn('https://eolymp.com/problems/1'), 1);
  assert.equal(api.numberIn('https://www.eolymp.com/uk/problems/8532?tab=statement'), 8532);
});

test('other text is searched as it is', () => {
  assert.equal(api.numberIn('sum of two'), undefined);
  assert.equal(api.numberIn('1'), undefined);
  assert.equal(api.numberIn('https://example.com/problems/1'), undefined);
  assert.equal(api.numberIn('https://eolymp.com/contests/1'), undefined);
});
