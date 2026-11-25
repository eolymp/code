const vscode = require('vscode');
const api = require('./api');

const t = vscode.l10n.t;
const FAMILIES = { cpp: 'cpp', py: 'python' };
const RUNNING = ['PENDING', 'PROVISIONING', 'INITIALIZING', 'TESTING'];
const VERDICTS = {
  ACCEPTED: 'accepted',
  WRONG_ANSWER: 'wrong-answer',
  TIME_LIMIT_EXCEEDED: 'time-limit',
  CPU_EXHAUSTED: 'time-limit',
  MEMORY_OVERFLOW: 'memory-limit',
  RUNTIME_ERROR: 'runtime-error',
  IDLENESS_LIMIT_EXCEEDED: 'idleness-limit',
  PARTIALLY_CORRECT: 'partial',
};

function verdictOf(item) {
  if (item.status === 'PENDING') return 'waiting';
  if (RUNNING.includes(item.status)) return 'testing';
  if (item.status === 'ERROR') return 'compilation-error';
  if (item.status === 'SKIPPED' || item.status === 'BLOCKED') return 'skipped';
  if (item.status === 'TIMEOUT') return 'time-limit';
  return (item.status === 'COMPLETE' && VERDICTS[item.verdict]) || 'failed';
}

function resultOf(item) {
  const judged = item.status === 'COMPLETE';
  return {
    index: item.index,
    verdict: verdictOf(item),
    score: item.score || 0,
    maxScore: item.cost || 0,
    time: judged ? item.timeUsage || 0 : undefined,
    memory: judged ? Number(item.memoryUsage) || 0 : undefined,
  };
}

function create(account) {
  const locale = () => vscode.env.language.slice(0, 2);
  const get = async (route, input) => {
    const token = await account.token();
    try {
      return await api.get(token, route, input);
    } catch (err) {
      if (!token || err.status !== 401) throw err;
      return api.get(undefined, route, input);
    }
  };

  const search = async (query) => {
    const text = query.trim();
    const number = api.numberIn(text);
    const input = number !== undefined ? { filters: { number: [{ is: 'EQUAL', value: number }] } } : { search: text };
    const { items = [] } = await get('/problems', { ...input, size: 30, locale: locale() });
    return items.map((p) => ({ id: p.id, label: `${p.number}. ${p.title}`, description: t('{0}% accepted', Math.round((p.acceptanceRate || 0) * 100)) }));
  };

  const load = async (id) => {
    const { problem } = await get(`/problems/${id}`, { locale: locale() });
    const { items = [] } = await get(`/problems/${id}/templates`, { size: 100 });
    const tests = await Promise.all((problem.examples || []).map(async (e) => ({ input: await api.text(e.inputUrl), answer: await api.text(e.answerUrl) })));
    const templates = {};
    for (const [lang, family] of Object.entries(FAMILIES)) {
      const template = items.find((item) => typeof item.source === 'string' && String(item.runtime).startsWith(`${family}:`));
      if (template) templates[lang] = template.source.replace(/\r\n/g, '\n');
    }
    return { name: `${problem.number} ${problem.title}`, url: problem.spaceLink, tests, templates };
  };

  const submit = async (problem, { language, source }) => {
    const token = await account.token(true);
    const { items = [] } = await api.get(token, `/problems/${problem.id}/runtime`);
    const offered = items.filter((r) => r.lang === FAMILIES[language]);
    const preferred = vscode.workspace.getConfiguration('eolymp').get('runtimes')[language] || [];
    const runtime = preferred.map((id) => offered.find((r) => r.id === id)).find(Boolean) || offered[0];
    if (!runtime) throw new Error(t('This problem does not take solutions in this language.'));
    const created = await api.post(token, '/submissions', { problemId: problem.id, lang: runtime.id, source });
    return created.submissionId;
  };

  const watch = async (problem, id, update, signal) => {
    const token = await account.token();
    for await (const { submission } of await api.stream(token, `/submissions/${id}/watch`, { extra: ['GROUPS', 'RUNS'] }, signal)) {
      const done = !RUNNING.includes(submission.status);
      update({
        ...resultOf(submission),
        id: submission.id,
        label: `#${submission.id.slice(0, 8).toUpperCase()}`,
        url: submission.spaceLink || problem.url,
        message: submission.error || (done && submission.errorUrl ? await api.text(submission.errorUrl).catch((err) => err.message) : ''),
        children: (submission.groups || []).map((group) => ({
          ...resultOf(group),
          kind: 'testset',
          children: (group.runs || []).map((run) => ({ ...resultOf(run), kind: 'test' })),
        })),
      });
    }
  };

  return { id: 'eolymp', label: 'Eolymp', search, load, submit, watch };
}

module.exports = { create };
