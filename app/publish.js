const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { repository } = require('./apt');

const repo = path.dirname(__dirname);
const LONG = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=300';

function required(name) {
  if (!process.env[name]) throw new Error(`${name} is not set`);
  return process.env[name];
}

function copy(source, target, cacheControl, recursive = false) {
  childProcess.execFileSync('aws', ['s3', 'cp', source, target, '--cache-control', cacheControl, ...(recursive ? ['--recursive'] : [])], { stdio: 'inherit' });
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
  for (const name of files) {
    const dot = name.indexOf('.');
    copy(path.join(artifacts, name), `${downloads}${version}/${name.slice(0, dot)}-${version}${name.slice(dot)}`, LONG);
  }
  for (const name of files) copy(path.join(artifacts, name), `${downloads}${name}`, SHORT);
  if (!stable) return;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
  const latest = path.join(work, 'latest.json');
  const download = JSON.parse(fs.readFileSync(path.join(__dirname, 'download.json'), 'utf8'));
  fs.writeFileSync(latest, `${JSON.stringify({ version, ...download }, null, 2)}\n`);
  copy(latest, `${downloads}latest.json`, SHORT);

  const dir = path.join(work, 'apt');
  const key = childProcess.execFileSync('aws', ['ssm', 'get-parameter', '--name', parameter, '--with-decryption', '--query', 'Parameter.Value', '--output', 'text'], { encoding: 'utf8' });
  repository(dir, key);
  copy(path.join(dir, 'pool'), `${apt}/pool`, LONG, true);
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
