const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { repository } = require('./apt');

const repo = path.dirname(__dirname);
const SHORT = 'public, max-age=300';
const PUBLIC = 'https://downloads.eolymp.com/code';
const FEEDS = [
  { file: 'eolymp-code-macos-arm64.zip', feed: 'stable/darwin/arm64/latest.json' },
  { file: 'eolymp-code-macos-x64.zip', feed: 'stable/darwin/x64/latest.json' },
  { file: 'eolymp-code-windows-x64.exe', feed: 'stable/win32/x64/user/latest.json' },
  { file: 'eolymp-code-windows-arm64.exe', feed: 'stable/win32/arm64/user/latest.json' },
];

function required(name) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
  return process.env[name];
}

function copy(source, target, cacheControl, recursive = false) {
  childProcess.execFileSync('aws', ['s3', 'cp', source, target, '--cache-control', cacheControl, ...(recursive ? ['--recursive'] : [])], { stdio: 'inherit' });
}

function versioned(name, version) {
  const dot = name.indexOf('.');
  return `${version}/${name.slice(0, dot)}-${version}${name.slice(dot)}`;
}

function digest(file, algorithm) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const [version] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version || '')) throw new Error('usage: node app/publish.js <version>');
  const stable = !version.includes('-');
  const downloads = `${required('DOWNLOADS_BUCKET')}/${stable ? '' : 'pre/'}`;
  const apt = stable ? required('APT_BUCKET') : '';
  const parameter = stable ? required('APT_SIGNING_KEY_PARAMETER') : '';

  const artifacts = path.join(repo, 'artifacts');
  const files = fs.readdirSync(artifacts).filter((name) => name.startsWith('eolymp-code-')).sort();
  if (!files.length) throw new Error(`${artifacts} has no eolymp-code files`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  const dir = path.join(work, 'apt');
  const commit = stable ? required('GITHUB_SHA') : '';
  for (const { file } of stable ? FEEDS : []) if (!files.includes(file)) throw new Error(`${artifacts} has no ${file}`);
  if (stable) {
    const key = childProcess.execFileSync('aws', ['ssm', 'get-parameter', '--name', parameter, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'], { encoding: 'utf8' });
    repository(dir, key);
  }

  for (const name of files) copy(path.join(artifacts, name), `${downloads}${versioned(name, version)}`, SHORT);
  for (const name of files) copy(path.join(artifacts, name), `${downloads}${name}`, SHORT);
  if (!stable) return;

  const latest = path.join(work, 'latest.json');
  const download = JSON.parse(fs.readFileSync(path.join(__dirname, 'download.json'), 'utf8'));
  fs.writeFileSync(latest, `${JSON.stringify({ version, ...download }, null, 2)}\n`);
  copy(latest, `${downloads}latest.json`, SHORT);

  const timestamp = String(Date.now());
  for (const { file, feed } of FEEDS) {
    const source = path.join(artifacts, file);
    const update = { url: `${PUBLIC}/${versioned(file, version)}`, name: version, version: commit, productVersion: version, hash: digest(source, 'sha1'), timestamp, sha256hash: digest(source, 'sha256') };
    const target = path.join(work, feed.replace(/\//g, '-'));
    fs.writeFileSync(target, `${JSON.stringify(update, null, 2)}\n`);
    copy(target, `${downloads}${feed}`, SHORT);
  }

  copy(path.join(dir, 'pool'), `${apt}/pool`, SHORT, true);
  for (const arch of fs.readdirSync(path.join(dir, 'dists', 'stable', 'main'))) {
    copy(path.join(dir, 'dists', 'stable', 'main', arch), `${apt}/dists/stable/main/${arch}`, 'no-cache', true);
  }
  for (const name of ['Release', 'Release.gpg', 'InRelease']) copy(path.join(dir, 'dists', 'stable', name), `${apt}/dists/stable/${name}`, 'no-cache');
}

try {
  main();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
