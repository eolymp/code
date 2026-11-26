const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ws = require('./workspace');
const { page } = require('./page');

const t = vscode.l10n.t;
const HOME = path.join(os.homedir(), 'Eolymp');

function durationOf(seconds) {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours && minutes % 60) return t('{0} h {1} min', hours, minutes % 60);
  return hours ? t('{0} h', hours) : t('{0} min', minutes);
}

const TONES = ['live', 'upcoming', 'attention', 'virtual', 'done', 'blocked'];

function cardOf(judge, contest) {
  const starts = contest.startsAt ? new Date(contest.startsAt) : undefined;
  const ends = contest.endsAt ? new Date(contest.endsAt) : undefined;
  const when = starts ? new Intl.DateTimeFormat(vscode.env.language, { dateStyle: 'medium', timeStyle: 'short' }).format(starts) : '';
  const length = starts && ends && ends > starts ? durationOf((ends - starts) / 1000) : '';
  return {
    judge: judge.id,
    id: String(contest.id),
    name: contest.name,
    image: /^https:\/\//.test(contest.image || '') ? contest.image : '',
    status: (contest.status || []).map((state) => ({ label: String(state.label), tone: TONES.includes(state.tone) ? state.tone : 'done' })),
    when: [when, length].filter(Boolean).join(' • '),
    entries: [
      { icon: 'calendar', text: when },
      { icon: 'judge', text: judge.label },
      { icon: 'watch', text: length },
      { icon: 'problems', text: contest.problems ? String(contest.problems) : '', hint: t('Problems: {0}', contest.problems) },
      { icon: 'participants', text: contest.participants ? String(contest.participants) : '', hint: t('Participants: {0}', contest.participants) },
    ].filter((entry) => entry.text),
    source: judge.label,
  };
}

function create({ judges, root, templateOf, refresh }) {
  let list;
  let panel;
  let shown;
  let asked = 0;
  let opened = 0;

  const place = (dir, judge, id, contest) => {
    const lang = vscode.workspace.getConfiguration('cp').get('language');
    ws.placeContest(dir, { judge: judge.id, id, contest, lang, template: templateOf(lang) });
  };

  const prepare = async (judge, id) => {
    const contest = await judge.loadContest(id, { signIn: true });
    const dir = ws.contestDirOf(HOME, judge.id, id) || ws.freshDirOf(HOME, contest.slug || contest.name || '');
    place(dir, judge, id, contest);
    return dir;
  };

  const openInEditor = async (judgeId, id) => {
    const judge = judges.get(judgeId);
    if (!judge) return;
    let dir;
    try {
      dir = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Preparing the contest workspace…') }, () => prepare(judge, id));
    } catch (err) {
      vscode.window.showErrorMessage(t('Could not open the contest: {0}', err.message));
      return;
    }
    if (root() && path.relative(root(), dir) === '') {
      refresh();
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceReuseWindow: true });
  };

  const search = async (query) => {
    asked += 1;
    const mine = asked;
    await Promise.allSettled(judges.declared().map((extension) => extension.activate()));
    if (mine !== asked) return;
    const all = judges.all().filter((judge) => judge.searchContests);
    const post = (message) => { if (list && mine === asked) list.webview.postMessage({ type: 'found', ...message }); };
    const found = await Promise.allSettled(all.map(async (judge) => (await judge.searchContests(query)).map((contest) => cardOf(judge, contest))));
    const failed = found.find((r) => r.status === 'rejected');
    const items = found.filter((r) => r.status === 'fulfilled').flatMap((r) => r.value);
    post({ items, error: failed && !items.length ? t('Could not search: {0}', failed.reason.message) : '' });
  };

  const postDetails = () => {
    if (!panel || !shown) return;
    panel.title = shown.card.name;
    panel.webview.postMessage({ ...shown.card, opening: t('Open in Editor'), visit: t('Open on {0}', shown.card.source), linked: Boolean(shown.url), heading: t('Problems') });
  };

  const details = async (judgeId, id) => {
    const judge = judges.get(judgeId);
    if (!judge) return;
    opened += 1;
    const mine = opened;
    let contest;
    try {
      contest = await judge.describeContest(id);
    } catch (err) {
      if (mine === opened) vscode.window.showErrorMessage(t('Could not open the contest: {0}', err.message));
      return;
    }
    if (mine !== opened) return;
    shown = { card: { ...cardOf(judge, contest), titles: (contest.titles || []).map((title, index) => ({ letter: ws.letterOf(index).toUpperCase(), title: String(title) })) }, url: contest.url };
    if (!panel) {
      panel = vscode.window.createWebviewPanel('cp.contest', shown.card.name, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.file(__dirname)] });
      panel.iconPath = new vscode.ThemeIcon('trophy');
      panel.webview.html = page(panel.webview, 'contest.html', { title: t('Contest') });
      panel.onDidDispose(() => { panel = undefined; });
      panel.webview.onDidReceiveMessage((m) => {
        if (m.type === 'ready') postDetails();
        if (m.type === 'open' && shown) openInEditor(shown.card.judge, shown.card.id);
        if (m.type === 'visit' && shown && shown.url) vscode.env.openExternal(vscode.Uri.parse(shown.url));
      });
    } else {
      panel.reveal();
    }
    postDetails();
  };

  const adopt = (judge) => {
    const here = root();
    const contest = here && ws.contestOf(here);
    if (!contest || contest.judge !== judge.id || !judge.loadContest) return;
    const links = fs.readdirSync(here, { withFileTypes: true })
      .map((entry) => entry.isDirectory() && ws.placeOf(path.join(here, entry.name)))
      .filter((link) => link && link.contest === contest.id);
    if (links.length && links.every((link) => link.id !== undefined)) return;
    judge.loadContest(contest.id).then((loaded) => {
      place(here, judge, contest.id, loaded);
      refresh();
    }, (err) => vscode.window.showWarningMessage(t('Could not update the contest problems: {0}', err.message)));
  };

  const register = (context) => {
    context.subscriptions.push(judges.onDidRegister(adopt), vscode.window.registerWebviewViewProvider('cp.contests', {
      resolveWebviewView(v) {
        list = v;
        v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(__dirname)] };
        v.webview.html = page(v.webview, 'contests.html', { title: t('Contests') });
        v.onDidDispose(() => { list = undefined; });
        v.webview.onDidReceiveMessage((m) => {
          if (m.type === 'ready') v.webview.postMessage({ type: 'strings', search: t('Search contests'), empty: t('No contests found.') });
          if (m.type === 'search') search(String(m.query || '')).catch(() => {});
          if (m.type === 'details') details(String(m.judge), String(m.id));
        });
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }));
  };

  return { register };
}

module.exports = { create };
