const fs = require('fs');
const path = require('path');

const LANGS = { '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.py': 'py' };
const TEST_FILES = ['in', 'out', 'answer'];
const LINK = '.problem.json';
const CONTEST = '.contest.json';

function natural(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
}

function list(dir, options) {
  try {
    return fs.readdirSync(dir, options);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function normalize(text) {
  return text.replace(/\r/g, '').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n+$/, '');
}

function slugOf(name) {
  return name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

function badName(value) {
  const text = value.trim();
  if (!text) return '';
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(text);
  return /[\\/:*?"<>|]/.test(text) || /^\.|\.$/.test(text) || reserved ? 'invalid' : '';
}

function langOf(file) {
  return LANGS[path.extname(file).toLowerCase()];
}

function solutionOf(file) {
  const lang = langOf(file);
  if (!lang) return undefined;
  const dir = path.dirname(file);
  const name = path.basename(file, path.extname(file));
  return { file, dir, name, lang, outDir: path.join(dir, '.build', name) };
}

function solutionsIn(dir) {
  const own = path.basename(dir);
  return list(dir)
    .filter(langOf)
    .sort((a, b) => (path.parse(b).name === own) - (path.parse(a).name === own) || natural(a, b))
    .map((f) => path.join(dir, f));
}

function testIds(dir) {
  return list(dir).filter((f) => f.endsWith('.in')).map((f) => f.slice(0, -3)).sort(natural);
}

function othersIn(dir) {
  const tests = new Set(testIds(dir));
  return list(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !langOf(entry.name))
    .map((entry) => entry.name)
    .filter((name) => !(/\.(in|out|answer)$/.test(name) && tests.has(name.replace(/\.[^.]+$/, ''))))
    .sort(natural)
    .map((name) => path.join(dir, name));
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && typeof value.judge === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function linkOf(dir) {
  const link = readJson(path.join(dir, LINK));
  return link && typeof link.id === 'string' ? link : undefined;
}

function placeOf(dir) {
  return readJson(path.join(dir, LINK));
}

function contestOf(dir) {
  const contest = readJson(path.join(dir, CONTEST));
  return contest && typeof contest.id === 'string' ? contest : undefined;
}

function letterOf(index) {
  return index < 26 ? String.fromCharCode(97 + index) : letterOf(Math.floor(index / 26) - 1) + letterOf(index % 26);
}

function isProblem(dir) {
  return solutionsIn(dir).length > 0 || testIds(dir).length > 0 || fs.existsSync(path.join(dir, LINK));
}

function problemsIn(dir) {
  return list(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && isProblem(path.join(dir, e.name)))
    .map((e) => e.name)
    .sort(natural)
    .map((name) => path.join(dir, name));
}

const answers = new Map();

function answerOf(dir, id) {
  const file = path.join(dir, `${id}.answer`);
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) {
    answers.delete(file);
    return undefined;
  }
  const stamp = `${stat.mtimeMs}:${stat.size}`;
  const kept = answers.get(file);
  if (kept && kept.stamp === stamp) return kept.text;
  const text = fs.readFileSync(file, 'utf8');
  answers.set(file, { stamp, text });
  return text;
}

function loadTests(dir) {
  return testIds(dir).map((id) => ({ id, input: read(path.join(dir, `${id}.in`)), answer: answerOf(dir, id) }));
}

function saveTest(dir, id, input) {
  fs.writeFileSync(path.join(dir, `${id}.in`), input);
  fs.rmSync(path.join(dir, `${id}.answer`), { force: true });
}

function saveExamples(dir, tests) {
  tests.forEach((test, index) => {
    const input = path.join(dir, `${index + 1}.in`);
    if (fs.existsSync(input)) return;
    fs.writeFileSync(input, test.input);
    fs.writeFileSync(path.join(dir, `${index + 1}.answer`), test.answer);
  });
}

function saveLink(file, link) {
  fs.writeFileSync(file, `${JSON.stringify(link, null, 2)}\n`);
}

function shortSlugOf(name, limit) {
  return slugOf(name).split('-').reduce((short, word) => (!short || `${short}-${word}`.length <= limit ? (short ? `${short}-${word}` : word) : short), '');
}

function contestDirOf(home, judge, id) {
  return list(home, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(home, entry.name))
    .find((dir) => {
      const contest = contestOf(dir);
      return contest && contest.judge === judge && contest.id === id;
    });
}

function freshDirOf(home, name) {
  const base = slugOf(name) || 'contest';
  for (let n = 1; ; n += 1) {
    const dir = path.join(home, n === 1 ? base : `${base}-${n}`);
    if (path.basename(dir) !== 'practice' && !fs.existsSync(dir)) return dir;
  }
}

function placeContest(dir, { judge, id, contest, lang, template }) {
  fs.mkdirSync(dir, { recursive: true });
  saveLink(path.join(dir, CONTEST), { judge, id, url: contest.url, name: contest.name });
  const folders = list(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ dir: path.join(dir, entry.name), link: placeOf(path.join(dir, entry.name)) }))
    .filter((folder) => folder.link && folder.link.judge === judge && folder.link.contest === id);
  contest.problems.forEach((problem, index) => {
    const letter = letterOf(index);
    const known = problem.id !== undefined;
    const kept = (known && folders.find((folder) => folder.link.id === String(problem.id)))
      || folders.find((folder) => folder.link.letter === letter && (!known || folder.link.id === undefined));
    const slug = known ? shortSlugOf(problem.name || '', 20) : '';
    const at = kept ? kept.dir : path.join(dir, slug ? `${letter}-${slug}` : letter);
    fs.mkdirSync(at, { recursive: true });
    const solution = solutionsIn(at).find((file) => langOf(file) === lang) || path.join(at, `${path.basename(at)}.${lang}`);
    const given = (problem.templates || {})[lang];
    const blank = fs.existsSync(solution) && read(solution) === template && solutionsIn(at).length === 1;
    if (!fs.existsSync(solution) || (given && blank)) fs.writeFileSync(solution, given || template);
    if (!known) {
      if (!kept) saveLink(path.join(at, LINK), { judge, contest: id, letter });
      return;
    }
    saveExamples(at, problem.tests || []);
    saveLink(path.join(at, LINK), { judge, id: String(problem.id), url: problem.url, contest: id, letter });
  });
}

function nextTest(dir) {
  const numbers = testIds(dir).map(Number).filter(Number.isInteger);
  return String(numbers.length ? Math.max(...numbers) + 1 : 1);
}

function verdictOf(output, answer) {
  if (answer === undefined) return 'no answer';
  return normalize(output) === normalize(answer) ? 'match' : 'differs';
}

module.exports = {
  TEST_FILES, LINK, CONTEST, linkOf, placeOf, contestOf, letterOf, read, slugOf, badName, langOf, solutionOf, solutionsIn, testIds,
  othersIn, problemsIn, answerOf, loadTests, saveTest, saveExamples, saveLink, shortSlugOf, contestDirOf, freshDirOf, placeContest, nextTest, verdictOf,
};
