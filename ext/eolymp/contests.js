const vscode = require('vscode');
const api = require('./api');

const t = vscode.l10n.t;

function stateOf(c, viewer) {
  const extra = viewer && viewer.unofficial ? [{ label: t('Unofficial'), tone: 'done' }] : [];
  switch (viewer && viewer.status) {
    case 'WAITING': return [{ label: t('Scheduled'), tone: 'upcoming' }, ...extra];
    case 'READY': return [{ label: t('Ready'), tone: 'live' }, ...extra];
    case 'ACTIVE': return [{ label: t('In progress'), tone: 'live' }, ...extra];
    case 'PAUSED': return [{ label: t('Paused'), tone: 'attention' }, ...extra];
    case 'UPSOLVE': return [{ label: t('Upsolve'), tone: 'attention' }, ...extra];
    case 'BLOCKED': return [{ label: t('Blocked'), tone: 'blocked' }, ...extra];
    case 'COMPLETE': return [{ label: t('Finished'), tone: 'done' }, ...extra];
    default: break;
  }
  switch (c.status) {
    case 'SCHEDULED': return [{ label: t('Scheduled'), tone: 'upcoming' }];
    case 'OPEN': return [{ label: t('Open'), tone: 'live' }];
    case 'FROZEN': return [{ label: t('Frozen'), tone: 'attention' }];
    case 'SUSPENDED': return [{ label: t('Suspended'), tone: 'blocked' }];
    case 'COMPLETE':
    case 'FINALIZED':
      if (c.allowFollowup) return [{ label: t('Virtual'), tone: 'virtual' }];
      if (c.allowUpsolve) return [{ label: t('Upsolve'), tone: 'attention' }];
      return [{ label: t('Finished'), tone: 'done' }];
    default: return [];
  }
}

function contestOf(c, viewer) {
  return {
    id: c.id,
    name: c.name,
    url: c.slug && c.spaceLink ? c.spaceLink.replace(/[^/]+$/, encodeURIComponent(c.slug)) : c.spaceLink,
    image: c.imageUrl,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    status: stateOf(c, viewer),
    problems: c.problemCountHidden ? undefined : c.problemCount,
    participants: c.participantCountHidden ? undefined : c.participantCount,
  };
}

function unless(...statuses) {
  return (err) => {
    if (statuses.includes(err.status)) return {};
    throw err;
  };
}

function create(account, { get, locale, pick, examplesOf, families }) {
  const viewerOf = async (token, id) => {
    if (!token) return undefined;
    const { participant } = await api.get(token, `/contests/${id}/introspect`).catch(unless(401, 404));
    return participant;
  };

  const describeContest = async (id) => {
    const { contest } = await get(`/contests/${id}`);
    const token = await account.token();
    const [viewer, { items = [] }] = await Promise.all([
      viewerOf(token, id),
      api.get(token, `/contests/${id}/problems`, { size: 100, locale: locale() }).catch(unless(401, 403)),
    ]);
    return { ...contestOf(contest, viewer), titles: items.sort((a, b) => a.index - b.index).map((problem) => problem.title) };
  };

  const searchContests = async (query) => {
    const text = query.trim();
    const id = api.contestIn(text);
    if (id) {
      const { contest } = await get(`/contests/${id}`);
      return [contestOf(contest, await viewerOf(await account.token(), contest.id))];
    }
    const input = { size: 30, sort: 'STARTS_AT', order: 'DESC', filters: { visibility: [{ is: 'EQUAL', value: 'PUBLIC' }] } };
    const { items = [] } = await get('/contests', text ? { ...input, search: text } : input);
    return items.map((c) => contestOf(c));
  };

  const loadContest = async (id, { signIn } = {}) => {
    const { contest } = await get(`/contests/${id}`);
    const shown = contestOf(contest);
    const token = await account.token(signIn).catch(() => undefined);
    const { items = [] } = await api.get(token, `/contests/${id}/problems`, { size: 100, locale: locale() }).catch(unless(401, 403));
    if (!items.length) return { ...shown, slug: contest.slug, problems: Array.from({ length: shown.problems || 0 }, () => ({})) };
    const problems = [];
    for (const problem of items.sort((a, b) => a.index - b.index)) {
      const base = `/contests/${id}/problems/${problem.id}`;
      const [{ items: examples = [] }, { items: runtimes = [] }] = await Promise.all([api.get(token, `${base}/examples`), api.get(token, `${base}/runtime`)]);
      const templates = {};
      for (const lang of families) {
        const runtime = pick(runtimes, lang);
        const { template } = runtime ? await api.get(token, `${base}/lookup-template`, { runtime: runtime.id }).catch(unless(404)) : {};
        if (template && typeof template.source === 'string') templates[lang] = template.source.replace(/\r\n/g, '\n');
      }
      problems.push({ id: problem.id, name: problem.title, url: problem.spaceLink || shown.url, tests: await examplesOf(examples), templates });
    }
    return { ...shown, slug: contest.slug, problems };
  };

  return { searchContests, describeContest, loadContest };
}

module.exports = { create };
