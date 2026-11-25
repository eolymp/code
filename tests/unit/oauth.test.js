const assert = require('node:assert/strict');
const { test } = require('node:test');
const oauth = require('../../extension/oauth');

test('the sign-in callback takes the code only with its own state', async () => {
  const local = await oauth.listen('expected', 'done');
  try {
    assert.equal((await fetch(`${local.redirect}?code=stolen&state=other`)).status, 404);
    const res = await fetch(`${local.redirect}?code=granted&state=expected`);
    assert.equal(await res.text(), 'done');
    assert.equal(await local.code, 'granted');
  } finally {
    local.close();
  }
});

test('a refused sign-in is reported', async () => {
  const local = await oauth.listen('expected', 'done');
  try {
    await fetch(`${local.redirect}?error=access_denied&state=expected`);
    await assert.rejects(local.code, oauth.Rejected);
  } finally {
    local.close();
  }
});
