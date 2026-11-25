const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETS = require('./tools.json');

function wanted() {
  const base = `${process.platform}-${process.arch}`;
  if (process.platform !== 'darwin') return SETS[base];
  const major = Number(os.release().split('.')[0]);
  const known = Object.keys(SETS).filter((key) => key.startsWith(`${base}-`)).map((key) => Number(key.split('-')[2])).sort((a, b) => b - a);
  const pick = known.find((version) => version <= major);
  return pick === undefined ? undefined : SETS[`${base}-${pick}`];
}

function id(set) {
  return set.sha256.slice(0, 12);
}

let sdkPath;

function sdk(again) {
  if (sdkPath === undefined || again) {
    const found = childProcess.spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
    sdkPath = found.status === 0 ? found.stdout.trim() : '';
  }
  return sdkPath;
}

function debugserver() {
  const found = childProcess.spawnSync('xcode-select', ['-p'], { encoding: 'utf8' });
  if (found.status !== 0) return '';
  const dir = found.stdout.trim();
  return [path.join(dir, '../SharedFrameworks/LLDB.framework/Resources/debugserver'), path.join(dir, 'Library/PrivateFrameworks/LLDB.framework/Resources/debugserver')].find((file) => fs.existsSync(file)) || '';
}

function installed(root) {
  const set = wanted();
  if (!set || !fs.existsSync(root)) return undefined;
  const base = fs.realpathSync(root);
  const names = [id(set), ...fs.readdirSync(base).filter((name) => name !== id(set)).sort().reverse()];
  for (const name of names) {
    const dir = path.join(base, name);
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(path.join(dir, 'ready'), 'utf8'));
    } catch {
      continue;
    }
    const at = (file) => (file ? path.join(dir, ...file.split('/')) : '');
    if (saved.dir !== dir || !fs.existsSync(at(saved.cxx))) continue;
    return { dir, current: name === id(set), cxx: at(saved.cxx), python: at(saved.python), clangd: at(saved.clangd), flags: saved.flags, env: saved.sdk && sdk() ? { SDKROOT: sdk() } : {} };
  }
  return undefined;
}

async function download(set, file, onBytes, signal) {
  const abort = new AbortController();
  if (signal.aborted) abort.abort();
  signal.addEventListener('abort', () => abort.abort(), { once: true });
  let stalled = setTimeout(() => abort.abort(), 60000);
  const out = fs.createWriteStream(file);
  let failure;
  out.on('error', (err) => { failure = err; });
  const hash = crypto.createHash('sha256');
  try {
    const response = await fetch(set.url, { signal: abort.signal });
    if (!response.ok) throw new Error(`${response.status} for ${set.url}`);
    for await (const chunk of response.body) {
      clearTimeout(stalled);
      stalled = setTimeout(() => abort.abort(), 60000);
      if (failure) throw failure;
      hash.update(chunk);
      onBytes(chunk.length, Number(response.headers.get('content-length')) || 0);
      if (!out.write(chunk)) {
        await new Promise((resolve) => {
          const done = () => { out.off('drain', done); out.off('error', done); resolve(); };
          out.on('drain', done);
          out.on('error', done);
        });
      }
    }
    await new Promise((resolve) => out.end(resolve));
    if (failure) throw failure;
  } catch (err) {
    out.destroy();
    throw abort.signal.aborted ? new Error('the download stopped') : err;
  } finally {
    clearTimeout(stalled);
  }
  if (hash.digest('hex') !== set.sha256) throw new Error('the download does not match its checksum');
}

function unpack(file, dir, signal) {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(tar, ['-xzf', file, '-C', dir], { signal, stdio: ['ignore', 'ignore', 'pipe'] });
    let problem = '';
    child.stderr.on('data', (data) => { problem = (problem + data).slice(-2000); });
    child.on('error', (err) => reject(signal.aborted ? new Error('stopped') : err));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(problem.trim().split('\n').pop() || 'unpacking stopped'))));
  });
}

function take(lock) {
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    return true;
  } catch {}
  try {
    const owner = Number(fs.readFileSync(lock, 'utf8'));
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    let alive = age < 30000;
    if (owner > 0) {
      try {
        process.kill(owner, 0);
        alive = true;
      } catch (err) {
        alive = err.code === 'EPERM';
      }
    }
    if (!alive || age > 900000) fs.rmSync(lock, { force: true });
  } catch {}
  return false;
}

async function install(location, report, signal) {
  const set = wanted();
  if (!set) throw new Error('there is no compiler package for this system');
  fs.mkdirSync(location, { recursive: true });
  const root = fs.realpathSync(location);
  const lock = path.join(root, 'lock');
  while (!take(lock)) {
    report('prepare', 0);
    if (signal.aborted) throw new Error('stopped');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  const beat = setInterval(() => fs.writeFileSync(lock, String(process.pid)), 10000);
  try {
    const have = installed(root);
    if (have && have.current) return have;
    const archive = path.join(root, 'download.tar.gz');
    let bytes = 0;
    await download(set, archive, (count, total) => {
      bytes += count;
      report('download', bytes, total ? Math.min(1, bytes / total) : 0);
    }, signal);
    report('unpack', 0);
    const dir = path.join(root, id(set));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    await unpack(archive, dir, signal);
    fs.rmSync(archive, { force: true });
    fs.writeFileSync(path.join(dir, 'ready'), JSON.stringify({ dir, cxx: set.cxx, python: set.python, clangd: set.clangd, flags: set.flags, sdk: set.sdk }));
    for (const other of fs.readdirSync(root)) {
      if (other === id(set) || other === 'lock') continue;
      try { fs.rmSync(path.join(root, other), { recursive: true, force: true }); } catch {}
    }
  } finally {
    clearInterval(beat);
    fs.rmSync(lock, { force: true });
  }
  return installed(root);
}

module.exports = { wanted, installed, install, sdk, debugserver };
