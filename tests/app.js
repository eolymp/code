const { test: base, expect, _electron: electron } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.EOLYMP_CODE_HOME || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'EolympCode') : path.join(os.homedir(), '.local/share/eolymp-code'));
const LAYOUT = {
  darwin: { program: 'editor/Eolymp Code.app/Contents/MacOS/Eolymp Code', data: 'editor/eolymp-code-portable-data' },
  linux: { program: 'editor/eolymp-code', data: 'editor/data' },
  win32: { program: 'editor/Eolymp Code.exe', data: 'editor/data' },
}[process.platform];

async function launch(files, tools) {
  const program = path.join(HOME, LAYOUT.program);
  const installed = path.join(HOME, LAYOUT.data);
  if (!fs.existsSync(program)) throw new Error(`Eolymp Code is not installed in ${HOME}. Install it, or set EOLYMP_CODE_HOME to where it is.`);
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'eolymp-code-test-'));
  const workspace = path.join(sandbox, 'practice');
  fs.mkdirSync(workspace);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), text);
  }
  const data = path.join(sandbox, 'data');
  fs.mkdirSync(path.join(data, 'user-data/User'), { recursive: true });
  fs.copyFileSync(path.join(installed, 'user-data/User/settings.json'), path.join(data, 'user-data/User/settings.json'));
  const extension = fs.readdirSync(path.join(installed, 'extensions')).find((name) => name.startsWith('eolymp.eolymp-code-'));
  fs.cpSync(path.join(installed, 'extensions', extension), path.join(data, 'extensions', extension), { recursive: true });
  const cache = path.join(os.tmpdir(), 'eolymp-code-test-tools');
  if (!tools) fs.rmSync(cache, { recursive: true, force: true });
  fs.mkdirSync(cache, { recursive: true });
  fs.mkdirSync(path.join(data, 'user-data/User/globalStorage/eolymp.eolymp-code'), { recursive: true });
  fs.symlinkSync(cache, path.join(data, 'user-data/User/globalStorage/eolymp.eolymp-code/tools'));
  const opened = Object.keys(files).slice(0, 1).map((file) => path.join(workspace, file));
  const app = await electron.launch({
    executablePath: program,
    args: [workspace, ...opened, '--use-mock-keychain'],
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
