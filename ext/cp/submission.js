const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const t = vscode.l10n.t;
const KINDS = { waiting: 'none', testing: 'busy', accepted: 'ok', partial: 'warn', skipped: 'none' };
const UNTESTED = ['compilation-error', 'failed'];
let view;
let shown;
let watching;

function verdictOf(code) {
  const names = {
    waiting: t('Waiting'),
    testing: t('Testing'),
    accepted: t('Accepted'),
    partial: t('Partially correct'),
    skipped: t('Skipped'),
    'wrong-answer': t('Wrong answer'),
    'time-limit': t('Time limit exceeded'),
    'memory-limit': t('Memory limit exceeded'),
    'idleness-limit': t('Idleness limit exceeded'),
    'runtime-error': t('Runtime error'),
    'compilation-error': t('Compilation error'),
    failed: t('Testing failed on the server'),
  };
  return names[code] || code;
}

function memoryOf(bytes) {
  return bytes >= 1 << 20 ? t('{0} MB', (bytes / (1 << 20)).toFixed(1)) : t('{0} kB', Math.round(bytes / 1024));
}

function rowOf(item) {
  const rows = (item.children || []).map(rowOf);
  const parent = item.kind !== 'test';
  return {
    kind: parent && item.verdict === 'waiting' ? 'busy' : KINDS[item.verdict] || 'bad',
    title: item.kind === 'testset' ? t('Testset {0}', item.index) : item.kind === 'test' ? t('Test {0}', item.index) : '',
    verdict: verdictOf(item.verdict),
    score: item.maxScore && !UNTESTED.includes(item.verdict) && (parent || item.time !== undefined) ? `${item.score || 0} / ${item.maxScore}` : '',
    time: item.time === undefined ? '' : t('{0} ms', item.time),
    memory: item.memory === undefined ? '' : memoryOf(item.memory),
    rows,
  };
}

function modelOf({ submission, name, judge }) {
  return {
    ...rowOf(submission),
    caption: t('Testing {0} at {1} ({2})', '\n', judge, submission.label || submission.id).split('\n'),
    name,
    id: submission.id,
    message: submission.message || '',
  };
}

function post() {
  if (view && shown) view.webview.postMessage(modelOf(shown));
}

async function watch(judge, link, id, file) {
  const name = path.basename(file);
  if (watching) watching.abort();
  const mine = new AbortController();
  watching = mine;
  shown = { submission: { id, verdict: 'waiting' }, name, file, judge: judge.label };
  post();
  await vscode.commands.executeCommand('setContext', 'cp.submitted', true);
  await vscode.commands.executeCommand('cp.submission.focus');
  try {
    await judge.watch(link, id, (submission) => {
      if (mine.signal.aborted) return;
      shown = { submission, name, file, judge: judge.label };
      post();
    }, mine.signal);
  } catch (err) {
    if (!mine.signal.aborted) throw err;
  }
}

function register(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('cp.openSubmission', () => {
      if (shown && shown.submission.url) vscode.env.openExternal(vscode.Uri.parse(shown.submission.url));
    }),
    vscode.window.registerWebviewViewProvider('cp.submission', {
      resolveWebviewView(v) {
        view = v;
        const nonce = crypto.randomBytes(16).toString('base64');
        v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(__dirname)] };
        v.webview.html = fs.readFileSync(path.join(__dirname, 'submission.html'), 'utf8')
          .replace(/{{nonce}}/g, nonce)
          .replace(/{{font}}/g, String(v.webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'codicon.ttf')))))
          .replace(/{{source}}/g, v.webview.cspSource);
        v.onDidDispose(() => { view = undefined; });
        v.webview.onDidReceiveMessage((m) => {
          if (m.type === 'ready') post();
          if (m.type === 'open' && shown) vscode.window.showTextDocument(vscode.Uri.file(shown.file));
        });
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
  );
}

module.exports = { register, watch };
