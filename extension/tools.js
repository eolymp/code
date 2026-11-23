const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const SETS = require('./tools.json');

function wanted() {
  const base = `${process.platform}-${process.arch}`;
  if (process.platform !== 'darwin') return SETS[base];
  const major = Number(os.release().split('.')[0]);
  const known = Object.keys(SETS).filter((key) => key.startsWith(`${base}-`)).map((key) => Number(key.split('-')[2])).sort((a, b) => b - a);
  const pick = known.find((version) => version <= major);
  return pick === undefined ? undefined : SETS[`${base}-${pick}`];
}

let sdkPath;

function sdk(again) {
  if (sdkPath === undefined || again) {
    const found = childProcess.spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' });
    sdkPath = found.status === 0 ? found.stdout.trim() : '';
  }
  return sdkPath;
}

function installed(root) {
  const set = wanted();
  if (!set || !fs.existsSync(root)) return undefined;
  const base = fs.realpathSync(root);
  const names = [set.id, ...fs.readdirSync(base).filter((name) => name !== set.id).sort().reverse()];
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
    return { dir, current: name === set.id, cxx: at(saved.cxx), python: at(saved.python), clangd: at(saved.clangd), flags: saved.flags, env: saved.sdk && sdk() ? { SDKROOT: sdk() } : {} };
  }
  return undefined;
}

async function download(item, file, onBytes, signal) {
  const abort = new AbortController();
  if (signal.aborted) abort.abort();
  signal.addEventListener('abort', () => abort.abort(), { once: true });
  let stalled = setTimeout(() => abort.abort(), 60000);
  const out = fs.createWriteStream(file);
  let failure;
  out.on('error', (err) => { failure = err; });
  const hash = crypto.createHash('sha256');
  try {
    const response = await fetch(item.url, { signal: abort.signal, headers: item.bearer ? { Authorization: `Bearer ${item.bearer}` } : {} });
    if (!response.ok) throw new Error(`${response.status} for ${item.url}`);
    for await (const chunk of response.body) {
      clearTimeout(stalled);
      stalled = setTimeout(() => abort.abort(), 60000);
      if (failure) throw failure;
      hash.update(chunk);
      onBytes(chunk.length);
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
    throw abort.signal.aborted ? new Error(`the download stopped: ${path.basename(item.url)}`) : err;
  } finally {
    clearTimeout(stalled);
  }
  if (hash.digest('hex') !== item.sha256) throw new Error(`the download does not match its checksum: ${path.basename(item.url)}`);
}

function untar(data, dest) {
  const text = (start, length) => data.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  const links = [];
  let longName;
  let longLink;
  for (let at = 0; at + 512 <= data.length;) {
    if (data[at] === 0) break;
    const size = parseInt(text(at + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(data[at + 156] || 48);
    const body = data.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'K') { longLink = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x' || type === 'g') {
      for (const record of body.toString('utf8').split('\n')) {
        const found = /^\d+ (path|linkpath)=(.*)$/s.exec(record);
        if (found && type === 'x') { if (found[1] === 'path') longName = found[2]; else longLink = found[2]; }
      }
      continue;
    }
    const header = at - 512 - Math.ceil(size / 512) * 512;
    const prefix = text(header + 345, 155);
    const name = longName || (prefix ? `${prefix}/` : '') + text(header, 100);
    const link = longLink || text(header + 157, 100);
    const mode = parseInt(text(header + 100, 8).trim() || '644', 8);
    longName = undefined;
    longLink = undefined;
    const target = path.join(dest, name);
    if (!target.startsWith(dest + path.sep) && target !== dest) continue;
    if (type === '5') fs.mkdirSync(target, { recursive: true });
    else if (type === '2' || type === '1') links.push({ type, target, link });
    else if (type === '0' || type === '7') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, body);
      fs.chmodSync(target, mode | 0o200);
    }
  }
  for (const { type, target, link } of links) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.rmSync(target, { force: true });
    if (type === '2') fs.symlinkSync(link, target);
    else if (fs.existsSync(path.join(dest, link))) fs.copyFileSync(path.join(dest, link), target);
  }
}

function conda(file, dest) {
  const data = fs.readFileSync(file);
  let end = data.length - 22;
  while (data.readUInt32LE(end) !== 0x06054b50) end -= 1;
  let at = data.readUInt32LE(end + 16);
  for (let i = data.readUInt16LE(end + 10); i > 0; i -= 1) {
    const name = data.toString('utf8', at + 46, at + 46 + data.readUInt16LE(at + 28));
    const size = data.readUInt32LE(at + 20);
    const local = data.readUInt32LE(at + 42);
    if (name.startsWith('pkg-')) {
      if (data.readUInt16LE(at + 10) !== 0) throw new Error(`unexpected compression in ${path.basename(file)}`);
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      untar(zlib.zstdDecompressSync(data.subarray(start, start + size), { maxOutputLength: 2 ** 31 - 1 }), dest);
    }
    at += 46 + data.readUInt16LE(at + 28) + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }
}

function run(command, args) {
  const result = childProcess.spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new Error(`${command} failed: ${(result.stderr || result.error || '').toString().trim().split('\n').pop()}`);
  return result.stdout;
}

function relocate(root) {
  const versions = Object.fromEntries(fs.readdirSync(root).map((name) => [name, fs.readdirSync(path.join(root, name))[0]]));
  const real = (name) => {
    const opt = /^@@HOMEBREW_PREFIX@@\/opt\/([^/]+)\/(.*)$/.exec(name);
    if (opt) return path.join(root, opt[1], versions[opt[1]], opt[2]);
    const cellar = /^@@HOMEBREW_CELLAR@@\/(.*)$/.exec(name);
    return cellar ? path.join(root, cellar[1]) : undefined;
  };
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { visit(file); continue; }
      const handle = fs.openSync(file, 'r');
      const magic = Buffer.alloc(4);
      fs.readSync(handle, magic, 0, 4, 0);
      fs.closeSync(handle);
      if (magic.readUInt32LE(0) !== 0xfeedfacf) continue;
      const args = [];
      for (const line of run('otool', ['-L', file]).split('\n').slice(1)) {
        const name = line.trim().split(' (')[0];
        if (real(name)) args.push('-change', name, real(name));
      }
      const own = run('otool', ['-D', file]).split('\n')[1];
      if (own && real(own.trim())) args.push('-id', real(own.trim()));
      if (!args.length) continue;
      fs.chmodSync(file, 0o755);
      run('install_name_tool', [...args, file]);
      run('codesign', ['--force', '--sign', '-', file]);
    }
  };
  visit(root);
}

function stored(set, index) {
  return `${index}-${path.basename(new URL(set.items[index].url).pathname)}`;
}

function unpack(root, report) {
  const set = wanted();
  const dir = path.join(root, set.id);
  const lock = path.join(root, 'lock');
  fs.writeFileSync(lock, String(process.pid));
  const downloads = path.join(root, 'downloads');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [index, item] of set.items.entries()) {
    report('unpack', index / set.items.length);
    fs.writeFileSync(lock, String(process.pid));
    const file = path.join(downloads, stored(set, index));
    const dest = path.join(dir, item.into);
    fs.mkdirSync(dest, { recursive: true });
    if (item.type === 'conda') conda(file, dest);
    else if (item.type === 'tar.gz') untar(zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: 2 ** 31 - 1 }), dest);
    else if (process.platform === 'win32') run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', file, '-C', dest]);
    else run(path.join(dir, ...set.python.split('/')), ['-m', 'zipfile', '-e', file, dest]);
  }
  if (process.platform === 'win32') for (const name of fs.readdirSync(path.join(dir, 'python'))) if (name.endsWith('._pth')) fs.rmSync(path.join(dir, 'python', name));
  if (set.clangd && process.platform !== 'win32') fs.chmodSync(path.join(dir, ...set.clangd.split('/')), 0o755);
  if (set.relocate) {
    report('prepare', 0);
    relocate(path.join(dir, set.relocate));
  }
  fs.rmSync(downloads, { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'ready'), JSON.stringify({ dir, cxx: set.cxx, python: set.python, clangd: set.clangd, flags: set.flags, sdk: set.sdk }));
  for (const other of fs.readdirSync(root)) {
    if (other === set.id || other === 'lock') continue;
    try { fs.rmSync(path.join(root, other), { recursive: true, force: true }); } catch {}
  }
}

function work(root, report, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('stopped')); return; }
    const child = childProcess.fork(__filename, [root], { silent: true });
    let problem = '';
    child.stderr.on('data', (data) => { problem = (problem + data).slice(-2000); });
    child.stdout.resume();
    child.on('message', (m) => { if (m.error) problem = m.error; else report(m.stage, m.value); });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(problem.trim().split('\n').pop() || 'unpacking stopped'))));
    signal.addEventListener('abort', () => {
      if (process.platform === 'win32') childProcess.spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
      else child.kill();
    }, { once: true });
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
  try {
    const have = installed(root);
    if (have && have.current) return have;
    const downloads = path.join(root, 'downloads');
    fs.mkdirSync(downloads, { recursive: true });
    let bytes = 0;
    const beat = setInterval(() => fs.writeFileSync(lock, String(process.pid)), 10000);
    try {
      for (const [index, item] of set.items.entries()) {
        await download(item, path.join(downloads, stored(set, index)), (count) => { bytes += count; report('download', bytes); }, signal);
      }
    } finally {
      clearInterval(beat);
    }
    await work(root, report, signal);
  } finally {
    fs.rmSync(lock, { force: true });
  }
  return installed(root);
}

if (require.main === module && process.send) {
  try {
    unpack(process.argv[2], (stage, value) => process.send({ stage, value }));
    process.disconnect();
  } catch (err) {
    process.send({ error: err.message }, () => process.exit(1));
  }
}

module.exports = { wanted, installed, install, sdk };
