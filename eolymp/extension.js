const vscode = require('vscode');
const path = require('path');
const account = require('./account');
const api = require('./api');

const t = vscode.l10n.t;
const RUNNING = ['PENDING', 'PROVISIONING', 'INITIALIZING', 'TESTING'];
let memory;

function verdictOf(submission) {
  if (submission.status === 'ERROR') return t('Compilation error');
  if (submission.status !== 'COMPLETE') return t('Testing failed on the server');
  const names = {
    ACCEPTED: t('Accepted'),
    WRONG_ANSWER: t('Wrong answer'),
    TIME_LIMIT_EXCEEDED: t('Time limit exceeded'),
    MEMORY_OVERFLOW: t('Memory limit exceeded'),
    RUNTIME_ERROR: t('Runtime error'),
    IDLENESS_LIMIT_EXCEEDED: t('Idleness limit exceeded'),
    PARTIALLY_CORRECT: t('Partially correct'),
  };
  return t('{0}, {1} of {2} points', names[submission.verdict] || submission.verdict, submission.score || 0, submission.cost || 0);
}

function mark() {
  const editor = vscode.window.activeTextEditor;
  const linked = editor && editor.document.uri.scheme === 'file' && api.linkOf(editor.document.fileName);
  vscode.commands.executeCommand('setContext', 'eolymp.linked', Boolean(linked));
}

const SITE = 'eolymp.com';

const judge = {
  id: api.JUDGE,
  label: 'Eolymp',
  async search(query) {
    const text = query.trim();
    const number = api.numberIn(text);
    const input = number ? { filters: { number: [{ is: 'EQUAL', value: number }] } } : { search: text };
    const { items } = await api.call(SITE, await account.token(false), 'GET', '/problems', { ...input, size: 30, locale: vscode.env.language.slice(0, 2) });
    return (items || []).map((p) => ({ id: p.id, label: `${p.number}. ${p.title}`, description: t('{0}% accepted', Math.round((p.acceptanceRate || 0) * 100)) }));
  },
  async load(id) {
    const { problem } = await api.call(SITE, await account.token(false), 'GET', `/problems/${id}`, { locale: vscode.env.language.slice(0, 2) });
    const tests = await Promise.all((problem.examples || []).map(async (e) => ({ input: await api.text(e.inputUrl), answer: await api.text(e.answerUrl) })));
    const { items } = await api.call(SITE, await account.token(false), 'GET', `/problems/${id}/templates`, { size: 100 });
    const templateFor = (family) => {
      const offered = (items || []).filter((x) => x.runtime.startsWith(`${family}:`));
      const template = offered.find((x) => x.runtime === memory.get(`runtime:${family}`)) || offered[0];
      return template && template.source.replace(/\r\n/g, '\n');
    };
    return { name: `${problem.number} ${problem.title}`, tests, templates: { cpp: templateFor('cpp'), py: templateFor('python') }, link: { id: problem.id, url: problem.spaceLink } };
  },
};

async function runtimeFor(link, token, family) {
  const { items } = await api.call(link.site, token, 'GET', `/problems/${link.problem}/runtime`);
  const offered = (items || []).filter((r) => r.lang === family);
  const kept = offered.find((r) => r.id === memory.get(`runtime:${family}`));
  if (kept || offered.length < 2) return kept || offered[0];
  const picked = await vscode.window.showQuickPick(offered.map((r) => ({ label: r.name, runtime: r })), { placeHolder: t('Language to submit in') });
  if (picked) await memory.update(`runtime:${family}`, picked.runtime.id);
  return picked && picked.runtime;
}

async function submit() {
  const editor = vscode.window.activeTextEditor;
  const link = editor && api.linkOf(editor.document.fileName);
  if (!link) return;
  const name = path.basename(editor.document.fileName);
  const source = editor.document.getText();
  try {
    const token = await account.token(true);
    const runtime = await runtimeFor(link, token, api.familyOf(editor.document.fileName));
    if (!runtime) return;
    const submission = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Testing {0} on {1}', name, link.site), cancellable: true }, async (_, cancel) => {
      const created = await api.call(link.site, token, 'POST', '/submissions', { problemId: link.problem, lang: runtime.id, source });
      for (;;) {
        const { submission: now } = await api.call(link.site, token, 'GET', `/submissions/${created.submissionId}`);
        if (!RUNNING.includes(now.status)) return now;
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
        if (cancel.isCancellationRequested) return undefined;
      }
    });
    if (!submission) return;
    const show = submission.verdict === 'ACCEPTED' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    const open = t('Open on {0}', link.site);
    if (await show(`${name}: ${verdictOf(submission)}`, open) === open) vscode.env.openExternal(vscode.Uri.parse(submission.spaceLink || link.url));
  } catch (err) {
    if (!(err instanceof vscode.CancellationError)) vscode.window.showErrorMessage(t('Could not submit {0}: {1}', name, err.message));
  }
}

async function activate(context) {
  memory = context.globalState;
  await account.register(context);
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${api.LINK}`);
  watcher.onDidCreate(mark);
  watcher.onDidDelete(mark);
  context.subscriptions.push(
    watcher,
    vscode.window.onDidChangeActiveTextEditor(mark),
    vscode.commands.registerCommand('eolymp.submit', submit),
  );
  mark();
  const core = await vscode.extensions.getExtension('eolymp.eolymp-code').activate();
  context.subscriptions.push(core.registerJudge(judge));
}

module.exports = { activate };
