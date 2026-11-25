const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MODAL = -4;
const LOCALES = JSON.parse(fs.readFileSync(path.join(__dirname, 'languages.json'), 'utf8'));

function create(context, setup, done) {
  let panel;

  const show = () => {
    if (panel) { panel.reveal(); return; }
    const settings = vscode.workspace.getConfiguration('eolympCode');
    const current = LOCALES.some((item) => item.id === vscode.env.language) ? vscode.env.language : 'en';
    const strings = (locale) => {
      const file = path.join(__dirname, 'l10n', `bundle.l10n.${locale}.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    };
    const locales = () => LOCALES.map((item) => ({ id: item.id, installed: !item.pack || Boolean(vscode.extensions.getExtension(item.pack)) }));
    const native = String(JSON.parse(process.env.VSCODE_NLS_CONFIG || '{}').osLocale || '').toLowerCase().split('-')[0].replace(/^ru$/, 'uk');
    const system = LOCALES.some((item) => item.id === native) ? native : '';
    let state = { locale: system || current, system, locales: locales(), strings: strings(system || current), language: settings.get('language'), ready: setup.ready(), failed: '', busy: false, progress: '', cheer: crypto.randomInt(10) };
    let finished = false;
    let cancelled = false;
    const post = () => { if (panel) panel.webview.postMessage(state); };
    const watching = setup.watch((progress, fraction) => {
      state = { ...state, progress: state.busy ? progress : '', fraction: state.busy ? fraction : undefined };
      post();
    });
    panel = vscode.window.createWebviewPanel('eolympCode.welcome', state.strings.Welcome || 'Welcome', MODAL, { enableScripts: true, retainContextWhenHidden: true });
    const nonce = crypto.randomBytes(16).toString('base64');
    panel.webview.html = fs.readFileSync(path.join(__dirname, 'welcome.html'), 'utf8').replace(/{{nonce}}/g, nonce);
    panel.onDidDispose(() => {
      panel = undefined;
      watching.dispose();
      if (state.busy) setup.stop();
      if (!finished) done(settings.get('language'));
    });
    panel.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'ready') post();
      if (m.type === 'locale' && LOCALES.some((item) => item.id === m.locale)) {
        state = { ...state, locale: m.locale, strings: strings(m.locale), failed: '' };
        panel.title = state.strings.Welcome || 'Welcome';
        post();
      }
      if (m.type === 'pack') {
        const wanted = LOCALES.find((item) => item.id === state.locale);
        const installed = await vscode.commands.executeCommand('workbench.extensions.installExtension', wanted.pack).then(() => true, () => false);
        for (let waited = 0; installed && waited < 15000 && !vscode.extensions.getExtension(wanted.pack); waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
        state = { ...state, locales: locales() };
        if (!state.locales.find((item) => item.id === wanted.id).installed) state = { ...state, failed: 'locale' };
        post();
      }
      if (m.type === 'language' && ['cpp', 'py'].includes(m.language)) {
        state = { ...state, language: m.language };
        post();
      }
      if (m.type === 'cancel') {
        cancelled = true;
        setup.stop();
      }
      if (m.type === 'finish' && !state.busy) {
        finished = true;
        await settings.update('language', state.language, vscode.ConfigurationTarget.Global);
        await context.globalState.update('onboarded', true);
        const restarting = state.locale !== current && await vscode.commands.executeCommand('eolympCode.setLocale', state.locale).then(() => true, () => false);
        if (restarting) return;
        panel.dispose();
        done(state.language);
      }
      if (m.type !== 'install' || state.busy || state.ready) return;
      state = { ...state, busy: true, failed: '', reason: '' };
      cancelled = false;
      post();
      let reason = '';
      const ready = await setup.fix((message) => { reason = message; });
      state = { ...state, busy: false, ready, failed: ready || cancelled ? '' : 'tools', reason: cancelled ? '' : reason, progress: '', fraction: undefined };
      post();
    });
  };

  return { show };
}

module.exports = { create };
