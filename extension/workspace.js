const fs = require('fs');
const path = require('path');

const LANGS = { '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.py': 'py' };
const TEST_FILES = ['in', 'out', 'answer'];
const LINK = '.problem.json';

function natural(a, b) {
  return a.localeCompare(b, undefined, { numeric: true });
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
  return fs.readdirSync(dir)
    .filter(langOf)
    .sort((a, b) => (path.parse(b).name === own) - (path.parse(a).name === own) || natural(a, b))
    .map((f) => path.join(dir, f));
}

function testIds(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.in')).map((f) => f.slice(0, -3)).sort(natural);
}

function othersIn(dir) {
  const tests = new Set(testIds(dir));
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !langOf(entry.name))
    .map((entry) => entry.name)
    .filter((name) => !(/\.(in|out|answer)$/.test(name) && tests.has(name.replace(/\.[^.]+$/, ''))))
    .sort(natural)
    .map((name) => path.join(dir, name));
}

function linkOf(dir) {
  try {
    const link = JSON.parse(fs.readFileSync(path.join(dir, LINK), 'utf8'));
    return typeof link.judge === 'string' && typeof link.id === 'string' ? link : undefined;
  } catch {
    return undefined;
  }
}

function isProblem(dir) {
  return solutionsIn(dir).length > 0 || testIds(dir).length > 0;
}

function problemsIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
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

function nextTest(dir) {
  const numbers = testIds(dir).map(Number).filter(Number.isInteger);
  return String(numbers.length ? Math.max(...numbers) + 1 : 1);
}

function verdictOf(output, answer) {
  if (answer === undefined) return 'no answer';
  return normalize(output) === normalize(answer) ? 'match' : 'differs';
}

module.exports = {
  TEST_FILES, LINK, linkOf, read, slugOf, badName, langOf, solutionOf, solutionsIn, testIds,
  othersIn, problemsIn, answerOf, loadTests, saveTest, nextTest, verdictOf,
};
