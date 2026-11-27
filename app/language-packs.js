const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const l10n = path.join(path.dirname(__dirname), 'l10n');

async function main() {
  const vsix = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'packs-')), 'pack.vsix');
  for (const name of fs.readdirSync(l10n).sort()) {
    const pack = path.join(l10n, name);
    if (!fs.existsSync(path.join(pack, 'package.json'))) continue;
    const manifest = JSON.parse(fs.readFileSync(path.join(pack, 'package.json'), 'utf8'));
    const id = `${manifest.publisher}/${manifest.name}/${manifest.version}`;
    const response = await fetch(`https://open-vsx.org/api/${id}`);
    if (response.ok) {
      console.log(`${id} is already published`);
      continue;
    }
    if (response.status !== 404) throw new Error(`${response.status} from Open VSX for ${id}`);
    childProcess.execFileSync('npx', ['-y', '@vscode/vsce@4.1.1', 'package', '--no-dependencies', '-o', vsix], { cwd: pack, stdio: 'inherit' });
    childProcess.execFileSync('npx', ['-y', 'ovsx@1.4.0', 'publish', vsix, '--trusted-publishing'], { stdio: 'inherit' });
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
