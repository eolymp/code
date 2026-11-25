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
  assert.equal(api.numberIn('https://eolymp.com/problems/12abc'), undefined);
});

test('a watch stream gives its messages until the end marker', async () => {
  const chunks = ['data: {"n":', '1}\n\n: keep-alive\n\ndata: {"n":2}\r\n\r', '\nevent: eof\ndata: {}\n\ndata: {"n":3}\n\n'].map((text) => new TextEncoder().encode(text));
  const seen = [];
  for await (const message of api.events(chunks)) seen.push(message.n);
  assert.deepEqual(seen, [1, 2]);
});

test('a watch stream that fails or breaks off is an error', async () => {
  const read = async (text) => { for await (const message of api.events([new TextEncoder().encode(text)])) assert.ok(message); };
  await assert.rejects(read('event: error\ndata: {"message":"denied"}\n\n'), /denied/);
  await assert.rejects(read('data: {"n":1}\n\n'), /closed/);
});
