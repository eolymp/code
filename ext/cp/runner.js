const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SHOWN = 256 << 10;
const checked = {};
const children = new Set();
let folder;
let counter = 0;
let stopped = false;

function start(command, args, options) {
  const child = childProcess.spawn(command, args, options);
  children.add(child);
  const gone = () => children.delete(child);
  child.on('error', gone);
  child.on('close', gone);
  if (stopped) child.kill();
  return child;
}

function measures(python) {
  if (!(python in checked)) {
    checked[python] = new Promise((resolve) => {
      const child = start(python, ['-c', 'pass'], { stdio: 'ignore', timeout: 10000 });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    }).catch(() => false);
  }
  return checked[python];
}

async function measured(python, command, args) {
  if (!await measures(python) || stopped) return { command, args, finish: (result) => result };
  if (!folder) folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-'));
  const stats = path.join(folder, `${counter += 1}.json`);
  const finish = (result) => {
    let found;
    try {
      found = JSON.parse(fs.readFileSync(stats, 'utf8'));
    } catch (err) {
      return result;
    }
    fs.rmSync(stats, { force: true });
    if (found.error) return { ...result, code: -1, signal: undefined, failure: found.error };
    return { ...result, code: found.code === undefined ? null : found.code, signal: found.signal, ms: found.cpu === undefined ? result.ms : found.cpu, memory: found.memory };
  };
  return { command: python, args: [path.join(__dirname, 'measure.py'), stats, command, ...args], finish };
}

async function collect(command, args, options, input) {
  const wrapped = options.python ? await measured(options.python, command, args) : { command, args, finish: (result) => result };
  return new Promise((done) => {
    const started = Date.now();
    const resolve = (result) => {
      const r = wrapped.finish(result);
      done(r.failure ? { ...r, stderr: `${r.stderr}${r.stderr && !r.stderr.endsWith('\n') ? '\n' : ''}${r.failure}\n` } : r);
    };
    const child = start(wrapped.command, wrapped.args, { cwd: options.cwd, env: options.env });
    const file = options.out && fs.createWriteStream(options.out);
    const hash = crypto.createHash('sha256');
    const head = [];
    let kept = 0;
    let size = 0;
    let stderr = '';
    const result = (more) => ({ stdout: Buffer.concat(head).toString('utf8'), stderr, size, trimmed: kept < size, hash: hash.digest('hex'), ms: Date.now() - started, ...more });
    let settled = false;
    const settle = (more) => {
      if (settled) return;
      settled = true;
      if (!file) resolve(result(more));
      else file.end(() => resolve(result(more)));
    };
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      size += d.length;
      hash.update(d);
      if (file && kept >= SHOWN) return;
      head.push(file ? d.subarray(0, SHOWN - kept) : d);
      kept += head[head.length - 1].length;
    });
    if (file) {
      file.on('error', () => {});
      child.stdout.pipe(file, { end: false });
    }
    child.stderr.on('data', (d) => { if (!file || stderr.length < SHOWN) stderr += d; });
    child.on('error', (err) => { stderr = String(err.message); settle({ code: -1, missing: err.code === 'ENOENT' }); });
    child.on('close', (code, signal) => settle({ code, signal }));
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
    if (options.onStart) options.onStart(child);
  });
}

function stopAll() {
  stopped = true;
  for (const child of children) child.kill();
  children.clear();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
}

function forget() {
  for (const python of Object.keys(checked)) delete checked[python];
}

module.exports = { SHOWN, start, measured, collect, stopAll, forget };
