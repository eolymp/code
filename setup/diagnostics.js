const vscode = require('vscode');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const toolset = require('./tools');

const t = vscode.l10n.t;
const STRINGS = ['Diagnostics', 'Checking…', 'Install', 'Fix', 'Check again', 'Reinstall', 'Everything works.', 'Eolymp Code needs a compiler and Python. Install them to start solving problems.', 'Some parts of Eolymp Code are not working.', 'Cancel'];

function hasAppleTools() {
  return process.platform !== 'darwin' || (childProcess.spawnSync('xcode-select', ['-p']).status === 0 && toolset.sdk(true) !== '');
}

function quick(root) {
  return hasAppleTools() && (!toolset.wanted() || Boolean(toolset.installed(root)));
}

function examine(root) {
  const checks = [];
  let group = t('Tools');
  const add = (id, title, ok, detail, fix) => checks.push({ id, group, title, ok, detail: ok ? '' : detail || '', fix: ok ? '' : fix || '' });
  if (process.platform === 'darwin') add('apple', t("Apple's Command Line Tools"), hasAppleTools(), t('They are needed by every compiler on macOS.'), 'apple');
  if (toolset.wanted()) add('tools', t('Compiler and Python'), Boolean(toolset.installed(root)), t('They are not installed yet.'), 'tools');
  group = t('Extensions');
  const extensions = [
    ['llvm-vs-code-extensions.vscode-clangd', t('C++ completion and errors')],
    ['vadimcn.vscode-lldb', t('C++ debugger')],
    ['detachhead.basedpyright', t('Python completion and errors')],
    ['ms-python.debugpy', t('Python debugger'), 'ms-python.python'],
    ['charliermarsh.ruff', t('Python formatting')],
  ];
  for (const [id, label, needs] of extensions) add(id, label, Boolean(vscode.extensions.getExtension(id) && (!needs || vscode.extensions.getExtension(needs))), t('the extension is not installed'));
  const clangd = vscode.workspace.getConfiguration('clangd').get('path') || 'clangd';
  const dirs = path.isAbsolute(clangd) ? [''] : (process.env.PATH || '').split(path.delimiter);
  const served = clangd.includes('${') || dirs.some((dir) => fs.existsSync(path.join(dir, clangd)) || fs.existsSync(path.join(dir, `${clangd}.exe`)));
  const completion = checks.find((c) => c.id === 'llvm-vs-code-extensions.vscode-clangd');
  if (completion.ok && !served) Object.assign(completion, { ok: false, detail: t('clangd was not found') });
  return checks;
}

function create(context, root, changed) {
  let panel;
  let running;
  let repairing = false;
  let stopper = new AbortController();
  let notify;
  let state = { checks: null, progress: '', fresh: !context.globalState.get('setup') };
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'eolympCode.checkSetup';
  bar.text = `$(warning) ${t('Setup')}`;
  bar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(bar);

  const watchers = new Set();
  const post = () => {
    if (panel) panel.webview.postMessage(state);
    for (const watcher of watchers) watcher(state.progress, state.fraction, state.source);
  };
  const progress = (text, fraction, source) => {
    state = { ...state, progress: text, fraction, source, stoppable: true };
    post();
    if (notify) notify.report({ message: text });
  };

  const check = () => {
    const checks = examine(root);
    const broken = checks.some((c) => c.fix);
    if (!broken) context.globalState.update('setup', true);
    state = { checks, progress: '', fresh: state.fresh && broken, managed: Boolean(toolset.wanted()) };
    if (broken) bar.show(); else bar.hide();
    post();
    return !broken;
  };

  const apple = async () => {
    if (hasAppleTools()) return;
    childProcess.spawn('xcode-select', ['--install'], { stdio: 'ignore' }).on('error', () => {});
    progress(t('Finish the installation in the window Apple opened. The setup continues by itself.'));
    for (let waited = 0; !hasAppleTools(); waited += 5) {
      if (waited > 3600 || stopper.signal.aborted) throw new Error(t("Apple's Command Line Tools were not installed."));
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        stopper.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  };

  const tools = async () => {
    const have = toolset.installed(root);
    if (!toolset.wanted() || (have && have.current)) return;
    await toolset.install(root, (stage, value, part) => {
      const source = stage === 'download' ? ['{0} MB downloaded', Math.round(value / 1048576)] : stage === 'unpack' ? ['Unpacking…'] : ['Preparing…'];
      const text = t(...source);
      const fraction = stage === 'download' ? Math.round(part * 80) / 100 : stage === 'unpack' ? Math.round(80 + value * 20) / 100 : undefined;
      if (text !== state.progress || fraction !== state.fraction) progress(text, fraction, source);
    }, stopper.signal);
    await changed();
  };

  let announce;
  const failed = (message) => {
    if (announce) {
      announce(message);
      return;
    }
    if (panel) vscode.window.showErrorMessage(message);
    else vscode.window.showErrorMessage(message, t('Show Details')).then((choice) => choice && open());
  };

  const repair = async () => {
    try {
      await apple();
      await tools();
    } catch (err) {
      if (!stopper.signal.aborted) failed(t('Could not finish the setup: {0}', err.message));
      check();
      return false;
    }
    const ok = check();
    if (!ok) failed(t('Some parts of Eolymp Code are not working.'));
    return ok;
  };

  const fix = (announced) => {
    if (repairing) return running;
    repairing = true;
    announce = announced;
    const mine = (running || Promise.resolve()).then(() => {
      stopper = new AbortController();
      return repair();
    }).finally(() => {
      repairing = false;
      announce = undefined;
      if (running === mine) running = undefined;
    });
    running = mine;
    return mine;
  };

  const reinstall = async () => {
    const have = toolset.installed(root);
    await vscode.commands.executeCommand('clangd.shutdown').then(undefined, () => {});
    if (have) fs.rmSync(path.join(have.dir, 'ready'), { force: true });
    await changed();
    if (await fix()) vscode.commands.executeCommand('clangd.restart').then(undefined, () => {});
  };

  const update = () => {
    if (running) return;
    stopper = new AbortController();
    const mine = tools().then(() => true, () => false).finally(() => {
      if (running === mine) running = undefined;
      state = { ...state, progress: '', stoppable: false };
      post();
    });
    running = mine;
  };

  const open = async () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('eolympCode.setup', t('Diagnostics'), vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.file(vscode.extensions.getExtension('eolymp.eolymp-code').extensionPath)] });
    const nonce = crypto.randomBytes(16).toString('base64');
    const font = panel.webview.asWebviewUri(vscode.Uri.file(path.join(vscode.extensions.getExtension('eolymp.eolymp-code').extensionPath, 'codicon.ttf')));
    panel.webview.html = fs.readFileSync(path.join(__dirname, 'diagnostics.html'), 'utf8')
      .replace(/{{nonce}}/g, nonce).replace(/{{font}}/g, String(font)).replace(/{{source}}/g, panel.webview.cspSource)
      .replace('{{strings}}', JSON.stringify(Object.fromEntries(STRINGS.map((text) => [text, t(text)]))).replace(/</g, '\\u003c'));
    panel.onDidDispose(() => { panel = undefined; });
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === 'ready') post();
      if (m.type === 'fix') fix();
      if (m.type === 'check' && !running) check();
      if (m.type === 'reinstall' && !running) reinstall();
      if (m.type === 'cancel') stopper.abort();
    });
    if (!running) check();
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
    const ok = check();
    const have = toolset.installed(root);
    if (have && !have.current) update();
    if (ok) return;
    const actions = state.checks.some((c) => c.fix) ? [t('Fix'), details] : [details];
    const choice = await vscode.window.showErrorMessage(t('Some parts of Eolymp Code are not working.'), ...actions);
    if (choice === details) await open();
    else if (choice) await install();
  };

  const install = async () => {
    const ok = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Setting up Eolymp Code'), cancellable: true }, (reporter, token) => {
      notify = reporter;
      token.onCancellationRequested(() => stopper.abort());
      return fix();
    });
    notify = undefined;
    if (ok) vscode.window.showInformationMessage(t('Eolymp Code is ready.'));
  };

  const watch = (watcher) => {
    watchers.add(watcher);
    return { dispose: () => watchers.delete(watcher) };
  };

  return { open, start, fix, watch, ready: () => quick(root), stop: () => stopper.abort() };
}

module.exports = { create };
