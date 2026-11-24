const { test: base, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROGRAM = process.env.EOLYMP_CODE_APP || {
  darwin: '/Applications/Eolymp Code.app/Contents/MacOS/Eolymp Code',
  linux: path.join(os.homedir(), '.local/share/eolymp-code/editor/eolymp-code'),
  win32: path.join(process.env.LOCALAPPDATA || '', 'EolympCode/editor/Eolymp Code.exe'),
}[process.platform];

async function launch(files, tools) {
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
  if (!tools) fs.rmSync(cache, { recursive: true, force: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.join(data, 'user-data/User/globalStorage/eolymp.eolymp-code-setup'), { recursive: true });
  fs.symlinkSync(cache, path.join(data, 'user-data/User/globalStorage/eolymp.eolymp-code-setup/tools'));
  const opened = Object.keys(files).slice(0, 1).map((file) => path.join(workspace, file));
  const app = await electron.launch({
    executablePath: PROGRAM,
    args: [workspace, ...opened, '--use-mock-keychain', ...(process.env.EOLYMP_CODE_SOURCE ? ['extension', 'setup'].map((name) => `--extensionDevelopmentPath=${path.join(__dirname, '..', name)}`) : [])],
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
  };
}

const test = base.extend({
  files: [{}, { option: true }],
  tools: [true, { option: true }],
  editor: async ({ files, tools }, use, testInfo) => {
    const editor = await launch(files, tools);
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
    }
    await editor.app.close();
    fs.rmSync(editor.sandbox, { recursive: true, force: true });
  },
});

module.exports = { test, expect };
