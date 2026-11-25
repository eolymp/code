const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const runner = require('../../ext/cp/runner');

const node = process.execPath;
const python = ['python3', 'python'].find((name) => childProcess.spawnSync(name, ['-c', 'pass']).status === 0);
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'eolymp-code-unit-'));

test('a program gets its input and its output, errors and exit code are collected', async () => {
  const r = await runner.collect(node, ['-e', 'process.stdin.on("data", (d) => { process.stdout.write(`got ${d}`); console.error("warn"); process.exitCode = 3; })'], {}, '12 9\n');
  assert.equal(r.stdout, 'got 12 9\n');
  assert.equal(r.stderr, 'warn\n');
  assert.equal(r.code, 3);
  assert.equal(r.trimmed, false);
});

test('a missing program is reported, not thrown', async () => {
  const r = await runner.collect(path.join(scratch(), 'no-such-program'), [], {});
  assert.equal(r.code, -1);
  assert.equal(r.missing, true);
});

test('long output is kept whole in a file and trimmed for display', async () => {
  const out = path.join(scratch(), '1.out');
  const r = await runner.collect(node, ['-e', 'process.stdout.write("line\\n".repeat(100000))'], { out });
  const full = fs.readFileSync(out);
  assert.equal(full.length, 500000);
  assert.equal(r.size, 500000);
  assert.equal(r.trimmed, true);
  assert.equal(Buffer.byteLength(r.stdout), runner.SHOWN);
  assert.equal(r.hash, crypto.createHash('sha256').update(full).digest('hex'));
});

test('short output with a file is not trimmed', async () => {
  const out = path.join(scratch(), '1.out');
  const r = await runner.collect(node, ['-e', 'console.log(21)'], { out });
  assert.equal(fs.readFileSync(out, 'utf8'), '21\n');
  assert.equal(r.stdout, '21\n');
  assert.equal(r.trimmed, false);
});

test('time, memory and a crash are measured through Python', { skip: !python }, async () => {
  const fine = await runner.collect(node, ['-e', 'console.log(1)'], { python });
  assert.equal(fine.code, 0);
  assert.ok(fine.memory > 1 << 20, `memory ${fine.memory}`);
  assert.ok(Number.isInteger(fine.ms) && fine.ms >= 0, `time ${fine.ms}`);
  const failed = await runner.collect(node, ['-e', 'process.exit(7)'], { python });
  assert.equal(failed.code, 7);
  if (process.platform !== 'win32') {
    const crashed = await runner.collect(node, ['-e', 'process.kill(process.pid, "SIGKILL")'], { python });
    assert.equal(crashed.signal, 'SIGKILL');
    assert.equal(crashed.code, null);
  }
});
