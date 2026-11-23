const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUTPUT_LIMIT = 16 << 20;
const checked = {};
const children = new Set();
let folder;
let counter = 0;

function start(command, args, options) {
  const child = childProcess.spawn(command, args, options);
  children.add(child);
  const gone = () => children.delete(child);
  child.on('error', gone);
  child.on('close', gone);
  return child;
}

function measures(python) {
  if (!(python in checked)) checked[python] = childProcess.spawnSync(python, ['-c', 'pass'], { timeout: 10000 }).status === 0;
  return checked[python];
}

function measured(python, command, args) {
  if (!measures(python)) return { command, args, finish: (result) => result };
  if (!folder) folder = fs.mkdtempSync(path.join(os.tmpdir(), 'eolymp-code-'));
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

function collect(command, args, options, input) {
  return new Promise((done) => {
    const started = Date.now();
    const wrapped = options.python ? measured(options.python, command, args) : { command, args, finish: (result) => result };
    const resolve = (result) => done(wrapped.finish(result));
    const child = start(wrapped.command, wrapped.args, { cwd: options.cwd, env: options.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let flooded = false;
    const timer = options.timeout && setTimeout(() => { timedOut = true; child.kill(); }, options.timeout);
    const take = (kept, chunk) => {
      if (kept.length + chunk.length <= OUTPUT_LIMIT) return kept + chunk;
      if (!flooded) child.kill();
      flooded = true;
      return kept + chunk.slice(0, OUTPUT_LIMIT - kept.length);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout = take(stdout, d); });
    child.stderr.on('data', (d) => { stderr = take(stderr, d); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, missing: err.code === 'ENOENT', stdout, stderr: String(err.message), ms: Date.now() - started, timedOut, flooded }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, ms: Date.now() - started, timedOut, flooded }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
    if (options.onStart) options.onStart(child);
  });
}

function stopAll() {
  for (const child of children) child.kill();
  children.clear();
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  folder = undefined;
}

function forget() {
  for (const python of Object.keys(checked)) delete checked[python];
}

module.exports = { OUTPUT_LIMIT, start, measures, measured, collect, stopAll, forget };
