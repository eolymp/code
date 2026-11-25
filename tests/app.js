const { test: base, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROGRAM = process.env.EOLYMP_CODE_APP || {
  darwin: '/Applications/Eolymp Code.app/Contents/MacOS/Eolymp Code',
  linux: '/usr/share/eolymp-code/eolymp-code',
  win32: path.join(process.env.LOCALAPPDATA || '', 'Programs/Eolymp Code/Eolymp Code.exe'),
}[process.platform];

async function launch(files, tools, settings) {
  if (!fs.existsSync(PROGRAM)) throw new Error(`Eolymp Code is not at ${PROGRAM}. Install it, or set EOLYMP_CODE_APP to its program.`);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eolymp-code-test-'));
  const workspace = path.join(sandbox, 'practice');
  fs.mkdirSync(workspace);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), text);
  }
  const data = path.join(sandbox, 'data');
  const cache = path.join(os.tmpdir(), 'eolymp-code-test-tools');
  fs.mkdirSync(cache, { recursive: true });
  if (!tools) for (const name of fs.readdirSync(cache)) fs.rmSync(path.join(cache, name), { recursive: true, force: true });
  fs.mkdirSync(path.join(data, 'user-data/User/globalStorage/eolymp.eolymp-code-setup'), { recursive: true });
  fs.symlinkSync(cache, path.join(data, 'user-data/User/globalStorage/eolymp.eolymp-code-setup/tools'));
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '../editor/settings.json'), 'utf8'));
  fs.writeFileSync(path.join(data, 'user-data/User/settings.json'), JSON.stringify({ ...defaults, 'window.dialogStyle': 'custom', 'window.menuStyle': 'custom', ...settings }));
  const opened = Object.keys(files).slice(0, 1).map((file) => path.join(workspace, file));
  const app = await electron.launch({
    executablePath: PROGRAM,
    args: [workspace, ...opened, '--use-mock-keychain', ...(process.env.EOLYMP_CODE_SOURCE ? ['extension', 'setup', 'eolymp'].map((name) => `--extensionDevelopmentPath=${path.join(__dirname, '..', name)}`) : [])],
    env: { ...process.env, VSCODE_PORTABLE: data },
  });
  const window = await app.firstWindow();
  return {
    app,
    window,
    workspace,
    sandbox,
    panel: window.frameLocator('iframe.webview[src*="purpose=webviewView"]').frameLocator('iframe#active-frame'),
    page: window.frameLocator('iframe.webview:not([src*="purpose=webviewView"])').frameLocator('iframe#active-frame'),
    toolbar: window.getByRole('toolbar', { name: 'Editor actions' }),
    tree: window.getByRole('tree', { name: 'Practice' }),
    box: window.locator('.quick-input-widget').getByRole('textbox'),
    pick: async (name) => {
      const item = window.getByRole('menuitem', { name, exact: true });
      await expect(item).toBeVisible();
      for (let moved = 0; moved < 30 && !await item.evaluate((element) => element === document.activeElement); moved += 1) await window.keyboard.press('ArrowDown');
      await window.keyboard.press('Enter');
      await expect(item).toBeHidden();
    },
    select: async (row) => {
      await row.click();
      await expect(row).toHaveAttribute('aria-selected', 'true');
    },
    answer: async (prompt, text) => {
      const widget = window.locator('.quick-input-widget');
      await expect(widget).toContainText(prompt);
      await widget.getByRole('textbox').fill(text);
      await expect(widget.getByRole('textbox')).toHaveValue(text);
      await widget.getByRole('textbox').press('Enter');
      await expect(widget).toBeHidden();
    },
    read: (file) => fs.readFileSync(path.join(workspace, file), 'utf8'),
    there: (file) => fs.existsSync(path.join(workspace, file)),
  };
}

const test = base.extend({
  files: [{}, { option: true }],
  tools: [true, { option: true }],
  settings: [undefined, { option: true }],
  editor: async ({ files, tools, settings }, use, testInfo) => {
    const editor = await launch(files, tools, settings);
    await editor.app.context().tracing.start({ screenshots: true, snapshots: true });
    await use(editor);
    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed) {
      const trace = testInfo.outputPath('app-trace.zip');
      const screenshot = testInfo.outputPath('window.png');
      await editor.app.context().tracing.stop({ path: trace });
      await editor.window.screenshot({ path: screenshot }).catch(() => {});
      await testInfo.attach('app trace', { path: trace });
      if (fs.existsSync(screenshot)) await testInfo.attach('window', { path: screenshot });
      const logs = path.join(editor.sandbox, 'data/user-data/logs');
      for (const entry of fs.existsSync(logs) ? fs.readdirSync(logs, { recursive: true, withFileTypes: true }) : []) {
        if (entry.name !== 'exthost.log') continue;
        fs.copyFileSync(path.join(entry.parentPath, entry.name), testInfo.outputPath('extension.log'));
        await testInfo.attach('extension log', { path: testInfo.outputPath('extension.log') });
      }
    }
    await editor.app.close();
    fs.rmSync(editor.sandbox, { recursive: true, force: true });
  },
});

module.exports = { test, expect };
