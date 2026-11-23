const vscode = require('vscode');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const runner = require('./runner');
const toolset = require('./tools');

const t = vscode.l10n.t;
const STRINGS = ['Diagnostics', 'Checking…', 'Install', 'Fix', 'Check again', 'Everything works.', 'Eolymp Code needs a compiler and Python. Install them to start solving problems.', 'Some parts of Eolymp Code are not working.', '{0} MB downloaded', 'Unpacking…', 'Preparing…', 'Finish the installation in the window Apple opened. The setup continues by itself.'];

function hasAppleTools() {
  return process.platform !== 'darwin' || (childProcess.spawnSync('xcode-select', ['-p']).status === 0 && toolset.sdk() !== '');
}

function quick(root) {
  return hasAppleTools() && (!toolset.wanted() || Boolean(toolset.installed(root)));
}

async function examine(root, use) {
  const checks = [];
  let group = t('Tools');
  const add = (id, title, ok, detail, fix) => checks.push({ id, group, title, ok, detail: ok ? '' : detail || '', fix: ok ? '' : fix || '' });
  if (process.platform === 'darwin') add('apple', t("Apple's Command Line Tools"), hasAppleTools(), t('They are needed by every compiler on macOS.'), 'apple');
  if (toolset.wanted()) add('tools', t('Compiler and Python'), Boolean(toolset.installed(root)), t('They are not installed yet.'), 'tools');
  group = t('Compiling and running');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eolymp-code-'));
  const env = use.env();
  const exe = path.join(dir, 'check' + (process.platform === 'win32' ? '.exe' : ''));
  fs.writeFileSync(path.join(dir, 'check.cpp'), '#include <bits/stdc++.h>\nint main() { int a, b; std::cin >> a >> b; std::cout << a + b; }\n');
  const compiled = await runner.collect(use.cxx(), [...use.flags(), 'check.cpp', '-o', exe], { cwd: dir, env });
  add('compile', t('C++ compiler'), compiled.code === 0, compiled.missing ? t('The compiler was not found: {0}', use.cxx()) : compiled.stderr.trim().split('\n')[0]);
  if (compiled.code === 0) {
    const ran = await runner.collect(exe, [], { cwd: dir, env, timeout: 5000 }, '2 3');
    add('run', t('C++ program runs'), ran.stdout.trim() === '5', ran.stderr.trim().split('\n')[0] || t('unexpected output'));
    const timed = await runner.collect(exe, [], { cwd: dir, env, timeout: 5000, python: use.python() }, '2 3');
    add('measure', t('Time and memory measuring'), timed.memory > 0, timed.failure || t('it needs a working Python'));
  }
  const python = await runner.collect(use.python(), ['-c', 'print(int(input()) + 3)'], { cwd: dir, env, timeout: 5000 }, '2');
  add('python', 'Python', python.stdout.trim() === '5', python.stderr.trim().split('\n').pop());
  group = t('Extensions');
  const extensions = [
    ['llvm-vs-code-extensions.vscode-clangd', t('C++ completion and errors')],
    ['vadimcn.vscode-lldb', t('C++ debugger')],
    ['detachhead.basedpyright', t('Python completion and errors')],
    ['ms-python.debugpy', t('Python debugger')],
    ['charliermarsh.ruff', t('Python formatting')],
  ];
  for (const [id, label] of extensions) add(id, label, Boolean(vscode.extensions.getExtension(id)), t('the extension is not installed'));
  fs.rmSync(dir, { recursive: true, force: true });
  return checks;
}

function create(context, root, use, changed) {
  let panel;
  let busy = false;
  let notify;
  let state = { checks: null, progress: '', fresh: !context.globalState.get('setup') };
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'eolympCode.checkSetup';
  bar.text = `$(warning) ${t('Setup')}`;
  bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(bar);

  const post = () => { if (panel) panel.webview.postMessage(state); };
  const progress = (text) => {
    state = { ...state, progress: text };
    post();
    if (notify) notify.report({ message: text });
  };

  const check = async () => {
    state = { ...state, progress: state.checks ? t('Checking…') : '' };
    post();
    const checks = await examine(root, use);
    const broken = checks.some((c) => !c.ok && (c.fix || ['compile', 'run', 'python', 'measure'].includes(c.id)));
    if (!broken) context.globalState.update('setup', true);
    state = { checks, progress: '', fresh: state.fresh && broken };
    if (broken) bar.show(); else bar.hide();
    post();
    return !broken;
  };

  const apple = async () => {
    if (hasAppleTools()) return;
    childProcess.spawn('xcode-select', ['--install'], { stdio: 'ignore' }).on('error', () => {});
    progress(t('Finish the installation in the window Apple opened. The setup continues by itself.'));
    for (let waited = 0; !hasAppleTools(); waited += 5) {
      if (waited > 3600) throw new Error(t("Apple's Command Line Tools were not installed."));
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  };

  const tools = async () => {
    if (!toolset.wanted() || toolset.installed(root)) return;
    await toolset.install(root, (stage, value) => {
      const text = stage === 'download' ? t('{0} MB downloaded', Math.round(value / 1048576)) : stage === 'unpack' ? t('Unpacking…') : t('Preparing…');
      if (text !== state.progress) progress(text);
    });
    changed();
  };

  const failed = (message) => {
    if (panel) vscode.window.showErrorMessage(message);
    else vscode.window.showErrorMessage(message, t('Show Details')).then((choice) => choice && open());
  };

  const fix = async () => {
    if (busy) return;
    busy = true;
    try {
      await apple();
      await tools();
    } catch (err) {
      failed(t('Could not finish the setup: {0}', err.message));
      busy = false;
      await check();
      return false;
    }
    busy = false;
    const ok = await check();
    if (!ok) failed(t('Some parts of Eolymp Code are not working.'));
    return ok;
  };

  const open = async () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('eolympCode.setup', t('Diagnostics'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.file(__dirname)] });
    const nonce = crypto.randomBytes(16).toString('base64');
    const font = panel.webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'codicon.ttf')));
    panel.webview.html = fs.readFileSync(path.join(__dirname, 'doctor.html'), 'utf8')
      .replace(/{{nonce}}/g, nonce).replace(/{{font}}/g, String(font)).replace(/{{source}}/g, panel.webview.cspSource)
      .replace('{{strings}}', JSON.stringify(Object.fromEntries(STRINGS.map((text) => [text, t(text)]))).replace(/</g, '\\u003c'));
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') post();
      if (m.type === 'fix') fix();
      if (m.type === 'check' && !busy) check();
    });
    if (!busy) await check();
  };

  const start = async () => {
    const details = t('Show Details');
    if (state.fresh && !quick(root)) {
      bar.show();
      const choice = await vscode.window.showInformationMessage(t('Eolymp Code needs a compiler and Python. Install them to start solving problems.'), t('Install'), details);
      if (choice === details) await open();
      else if (choice) await install();
      return;
    }
    if (await check()) return;
    const actions = state.checks.some((c) => c.fix) ? [t('Fix'), details] : [details];
    const choice = await vscode.window.showErrorMessage(t('Some parts of Eolymp Code are not working.'), ...actions);
    if (choice === details) await open();
    else if (choice) await install();
  };

  const install = async () => {
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Setting up Eolymp Code') }, (reporter) => {
      notify = reporter;
      return fix();
    });
    notify = undefined;
    if (ok) vscode.window.showInformationMessage(t('Eolymp Code is ready.'));
  };

  return { open, start, install, ready: () => quick(root) };
}

module.exports = { create };
