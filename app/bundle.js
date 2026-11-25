const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const [app, platform, cache] = process.argv.slice(2);
const repo = path.dirname(__dirname);
const extensions = path.join(app, 'extensions');

async function fetched(url, sha256) {
  const file = path.join(cache, sha256);
  if (!fs.existsSync(file)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} for ${url}`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) {
    fs.rmSync(file);
    throw new Error(`${url} does not match editor/pins.txt`);
  }
  return file;
}

function placed(source) {
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const target = path.join(extensions, `${manifest.publisher}.${manifest.name}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  return { target, manifest };
}

async function main() {
  fs.mkdirSync(cache, { recursive: true });
  let pinned = 0;
  for (const line of fs.readFileSync(path.join(repo, 'editor', 'pins.txt'), 'utf8').split('\n')) {
    const [target, sha256, url] = line.trim().split(' ');
    if (target !== platform || !url.endsWith('.vsix')) continue;
    pinned += 1;
    const unpacked = path.join(cache, `${sha256}.dir`);
    fs.rmSync(unpacked, { recursive: true, force: true });
    childProcess.execFileSync('unzip', ['-q', await fetched(url, sha256), 'extension/*', '-d', unpacked]);
    placed(path.join(unpacked, 'extension'));
    fs.rmSync(unpacked, { recursive: true, force: true });
  }

  if (!pinned) throw new Error(`editor/pins.txt lists no extensions for ${platform}`);

  for (const name of fs.readdirSync(path.join(repo, 'ext'))) {
    const own = placed(path.join(repo, 'ext', name));
    if (!process.env.EOLYMP_CODE_VERSION) continue;
    own.manifest.version = process.env.EOLYMP_CODE_VERSION;
    fs.writeFileSync(path.join(own.target, 'package.json'), `${JSON.stringify(own.manifest, null, 2)}\n`);
  }

  fs.mkdirSync(path.join(app, 'defaults'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'editor', 'settings.json'), path.join(app, 'defaults', 'settings.json'));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
