const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const repo = path.dirname(__dirname);
const architectures = ['amd64', 'arm64'];

function run(command, args, options = {}) {
  return childProcess.execFileSync(command, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'], ...options });
}

function repository(dir, key) {
  if (!key) throw new Error('no signing key');
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} is not empty`);

  const pool = path.join(dir, 'pool');
  fs.mkdirSync(pool, { recursive: true });
  const artifacts = path.join(repo, 'artifacts');
  const debs = fs.readdirSync(artifacts).filter((name) => /^eolymp-code-linux-.+\.deb$/.test(name));
  if (!debs.length) throw new Error(`${artifacts} has no .deb packages`);
  for (const name of debs) {
    const deb = path.join(artifacts, name);
    const [pkg, version, arch] = ['Package', 'Version', 'Architecture'].map((field) => run('dpkg-deb', ['-f', deb, field]).trim());
    fs.copyFileSync(deb, path.join(pool, `${pkg}_${version}_${arch}.deb`));
  }

  const stable = path.join(dir, 'dists', 'stable');
  for (const arch of architectures) {
    const index = path.join(stable, 'main', `binary-${arch}`);
    fs.mkdirSync(index, { recursive: true });
    const packages = run('apt-ftparchive', ['--arch', arch, 'packages', 'pool'], { cwd: dir });
    fs.writeFileSync(path.join(index, 'Packages'), packages);
    fs.writeFileSync(path.join(index, 'Packages.gz'), zlib.gzipSync(packages, { level: 9 }));
  }

  const fields = { Origin: 'Eolymp', Label: 'Eolymp Code', Suite: 'stable', Codename: 'stable', Architectures: architectures.join(' '), Components: 'main' };
  const options = Object.entries(fields).flatMap(([name, value]) => ['-o', `APT::FTPArchive::Release::${name}=${value}`]);
  const release = run('apt-ftparchive', [...options, 'release', 'dists/stable'], { cwd: dir });
  fs.writeFileSync(path.join(stable, 'Release'), release);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gnupg-'));
  const env = { ...process.env, GNUPGHOME: home };
  try {
    run('gpg', ['--batch', '--quiet', '--import'], { env, input: key });
    run('gpg', ['--batch', '--yes', '--clearsign', '-o', path.join(stable, 'InRelease'), path.join(stable, 'Release')], { env });
    run('gpg', ['--batch', '--yes', '--armor', '--detach-sign', '-o', path.join(stable, 'Release.gpg'), path.join(stable, 'Release')], { env });
  } finally {
    run('gpgconf', ['--kill', 'gpg-agent'], { env });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

module.exports = { repository };

if (require.main === module) {
  try {
    const [dir] = process.argv.slice(2);
    if (!dir) throw new Error('usage: APT_SIGNING_KEY=<private key> node app/apt.js <dir>');
    repository(dir, process.env.APT_SIGNING_KEY);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
