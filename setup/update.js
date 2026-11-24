const vscode = require('vscode');

const t = vscode.l10n.t;
const BASE = 'https://downloads.eolymp.com/code/';
const PACKAGES = { darwin: `EolympCode-macos-${process.arch}.dmg`, linux: `EolympCode-linux-${process.arch}.deb`, win32: 'EolympCode-windows-x64.exe' };

function newer(latest, current) {
  const numbers = (version) => version.split('-')[0].split('.').map(Number);
  const [a, b] = [numbers(latest), numbers(current)];
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return current.includes('-');
}

async function check(context) {
  if (Date.now() - (context.globalState.get('updateChecked') || 0) < 86400000) return;
  await context.globalState.update('updateChecked', Date.now());
  const response = await fetch(`${BASE}latest.json`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return;
  const { version } = await response.json();
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return;
  if (!newer(version, context.extension.packageJSON.version) || context.globalState.get('updateSkipped') === version) return;
  const download = t('Download');
  const skip = t('Skip This Version');
  const choice = await vscode.window.showInformationMessage(t('Eolymp Code {0} is available.', version), download, skip);
  if (choice === download) vscode.env.openExternal(vscode.Uri.parse(BASE + PACKAGES[process.platform]));
  else if (choice === skip) context.globalState.update('updateSkipped', version);
}

module.exports = { check, newer };
