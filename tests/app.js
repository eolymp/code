const { test: base, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BUILT = path.join(process.env.EOLYMP_CODE_BUILD_DIR || path.join(__dirname, '../.build'), `vscodium/VSCode-${process.platform}-${process.arch}`);
const TOOLS = path.join(os.tmpdir(), 'eolymp-code-test-tools');
const PROGRAM = process.env.EOLYMP_CODE_APP || path.join(BUILT, {
  darwin: 'Eolymp Code.app/Contents/MacOS/Eolymp Code',
  linux: 'eolymp-code',
  win32: 'Eolymp Code.exe',
}[process.platform]);

async function launch(files, tools, settings) {
  if (!fs.existsSync(PROGRAM)) throw new Error(`Eolymp Code is not at ${PROGRAM}. Build it with app/build.sh build, or set EOLYMP_CODE_APP to its program.`);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eolymp-code-test-'));
  const workspace = path.join(sandbox, 'practice');
  fs.mkdirSync(workspace);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), text);
  }
  const data = path.join(sandbox, 'data');
  fs.mkdirSync(TOOLS, { recursive: true });
  if (!tools) for (const name of fs.readdirSync(TOOLS)) fs.rmSync(path.join(TOOLS, name), { recursive: true, force: true });
  fs.mkdirSync(path.join(data, 'user-data/User/globalStorage/eolymp.core'), { recursive: true });
  fs.symlinkSync(TOOLS, path.join(data, 'user-data/User/globalStorage/eolymp.core/tools'), 'junction');
  const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, '../editor/settings.json'), 'utf8'));
  fs.writeFileSync(path.join(data, 'user-data/User/settings.json'), JSON.stringify({ ...defaults, 'window.dialogStyle': 'custom', 'window.menuStyle': 'custom', ...settings }));
  const opened = Object.keys(files).slice(0, 1).map((file) => path.join(workspace, file));
  const app = await electron.launch({
    executablePath: PROGRAM,
    args: [workspace, ...opened, '--use-mock-keychain', '--use-inmemory-secretstorage', ...['cp', 'core', 'eolymp'].map((name) => `--extensionDevelopmentPath=${path.join(__dirname, '..', 'ext', name)}`)],
    env: { ...process.env, VSCODE_PORTABLE: data },
  });
  await app.context().tracing.start({ screenshots: true, snapshots: true });
  const window = await app.firstWindow();
  return {
    app,
    window,
    workspace,
    sandbox,
    panel: window.frameLocator('iframe.webview[src*="purpose=webviewView"]').frameLocator('iframe#active-frame'),
    page: window.frameLocator('iframe.webview:not([src*="purpose=webviewView"])').frameLocator('iframe#active-frame'),
    toolbar: window.getByRole('toolbar', { name: 'Editor actions' }),
    tools: window.locator('.part.panel .title'),
    tree: window.getByRole('tree', { name: 'Practice' }),
    box: window.locator('.quick-input-widget').getByRole('textbox'),
    pick: async (name) => {
      const item = window.getByRole('menuitem', { name, exact: true });
      await expect(item).toBeVisible();
      for (let moved = 0; moved < 30 && !await item.evaluate((element) => element === document.activeElement); moved += 1) await window.keyboard.press('ArrowDown');
      await expect(item).toBeFocused();
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
    await use(editor);
    const failed = testInfo.status !== testInfo.expectedStatus;
    if (failed) {
      const trace = testInfo.outputPath('app-trace.zip');
      const screenshot = testInfo.outputPath('window.png');
      await editor.app.context().tracing.stop({ path: trace });
      await editor.window.screenshot({ path: screenshot }).catch(() => {});
      await testInfo.attach('app trace', { path: trace });
      if (fs.existsSync(screenshot)) await testInfo.attach('window', { path: screenshot });
    }
    await editor.app.close();
    fs.rmSync(editor.sandbox, { recursive: true, force: true });
  },
});

module.exports = { test, expect, TOOLS };
