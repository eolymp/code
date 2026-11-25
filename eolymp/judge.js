const vscode = require('vscode');
const api = require('./api');

const t = vscode.l10n.t;
const FAMILIES = { cpp: 'cpp', py: 'python' };

function create(account) {
  const locale = () => vscode.env.language.slice(0, 2);

  const search = async (query) => {
    const text = query.trim();
    const number = api.numberIn(text);
    const input = number !== undefined ? { filters: { number: [{ is: 'EQUAL', value: number }] } } : { search: text };
    const { items = [] } = await api.get(await account.token(), '/problems', { ...input, size: 30, locale: locale() });
    return items.map((p) => ({ id: p.id, label: `${p.number}. ${p.title}`, description: t('{0}% accepted', Math.round((p.acceptanceRate || 0) * 100)) }));
  };

  const load = async (id) => {
    const token = await account.token();
    const { problem } = await api.get(token, `/problems/${id}`, { locale: locale() });
    const { items = [] } = await api.get(token, `/problems/${id}/templates`, { size: 100 });
    const tests = await Promise.all((problem.examples || []).map(async (e) => ({ input: await api.text(e.inputUrl), answer: await api.text(e.answerUrl) })));
    const templates = {};
    for (const [lang, family] of Object.entries(FAMILIES)) {
      const template = items.find((item) => typeof item.source === 'string' && String(item.runtime).startsWith(`${family}:`));
      if (template) templates[lang] = template.source.replace(/\r\n/g, '\n');
    }
    return { name: `${problem.number} ${problem.title}`, tests, templates, link: { id: problem.id, url: problem.spaceLink } };
  };

  return { id: 'eolymp', label: 'Eolymp', search, load };
}

module.exports = { create };
