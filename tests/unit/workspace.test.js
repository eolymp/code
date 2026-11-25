const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const ws = require('../../ext/cp/workspace');

function folder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eolymp-code-unit-'));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const names = (files) => files.map((file) => path.basename(file));

test('a problem name becomes a folder name', () => {
  assert.equal(ws.slugOf('  Two Sum!  '), 'two-sum');
  assert.equal(ws.slugOf('Сума чисел'), 'сума-чисел');
  assert.equal(ws.slugOf('a__b--c'), 'a-b-c');
  assert.equal(ws.slugOf('***'), '');
});

test('names that cannot be files are rejected', () => {
  for (const name of ['a/b', 'a\\b', 'a:b', 'what?', '.hidden', 'dot.', 'con', 'NUL.txt', 'com1']) assert.equal(ws.badName(name), 'invalid', name);
  for (const name of ['brute', 'brute.cpp', 'large number', 'тест', '']) assert.equal(ws.badName(name), '', name);
});

test('solutions are recognised by extension', () => {
  assert.equal(ws.langOf('a.cpp'), 'cpp');
  assert.equal(ws.langOf('a.CC'), 'cpp');
  assert.equal(ws.langOf('a.cxx'), 'cpp');
  assert.equal(ws.langOf('a.py'), 'py');
  assert.equal(ws.langOf('a.txt'), undefined);
  assert.equal(ws.solutionOf('/p/sum/notes.md'), undefined);
  assert.deepEqual(ws.solutionOf(path.join('/p', 'sum', 'brute.cpp')), { file: path.join('/p', 'sum', 'brute.cpp'), dir: path.join('/p', 'sum'), name: 'brute', lang: 'cpp', outDir: path.join('/p', 'sum', '.build', 'brute') });
});

test('output is compared ignoring trailing spaces and blank lines at the end', () => {
  assert.equal(ws.verdictOf('1 2 \n3\n\n\n', '1 2\n3'), 'match');
  assert.equal(ws.verdictOf('1\r\n2\r\n', '1\n2\n'), 'match');
  assert.equal(ws.verdictOf('1\n\n2\n', '1\n2\n'), 'differs');
  assert.equal(ws.verdictOf(' 1\n', '1\n'), 'differs');
  assert.equal(ws.verdictOf('1  2\n', '1 2\n'), 'differs');
  assert.equal(ws.verdictOf('', ''), 'match');
  assert.equal(ws.verdictOf('1\n', undefined), 'no answer');
});

test('a problem folder is read into solutions, tests and other files', () => {
  const dir = folder({
    'sum/brute.cpp': '', 'sum/sum.py': '', 'sum/sum10.cpp': '', 'sum/sum2.cpp': '',
    'sum/10.in': '', 'sum/2.in': '', 'sum/2.answer': '', 'sum/2.out': '', 'sum/big.in': '',
    'sum/notes.txt': '', 'sum/7.answer': '', 'sum/.clangd': '', 'sum/.build/sum/run': '',
  });
  const sum = path.join(dir, 'sum');
  assert.deepEqual(names(ws.solutionsIn(sum)), ['sum.py', 'brute.cpp', 'sum2.cpp', 'sum10.cpp']);
  assert.deepEqual(ws.testIds(sum), ['2', '10', 'big']);
  assert.deepEqual(names(ws.othersIn(sum)), ['7.answer', 'notes.txt']);
  assert.equal(ws.nextTest(sum), '11');
  assert.equal(ws.nextTest(path.join(dir, 'missing')), '1');
});

test('a folder is a problem when it has a solution or a test', () => {
  const dir = folder({ 'b/b.cpp': '', 'a10/1.in': '', 'a2/x.py': '', 'notes/readme.md': '', '.hidden/h.cpp': '', 'top.cpp': '' });
  assert.deepEqual(names(ws.problemsIn(dir)), ['a2', 'a10', 'b']);
});

test('tests are loaded with their input and answer, and an edited answer is read again', () => {
  const dir = folder({ '1.in': '5\n', '1.answer': '25\n', '2.in': '6\n' });
  assert.deepEqual(ws.loadTests(dir), [{ id: '1', input: '5\n', answer: '25\n' }, { id: '2', input: '6\n', answer: undefined }]);
  fs.writeFileSync(path.join(dir, '1.answer'), '26 \n');
  assert.equal(ws.answerOf(dir, '1'), '26 \n');
  fs.rmSync(path.join(dir, '1.answer'));
  assert.equal(ws.answerOf(dir, '1'), undefined);
});

test('a saved test starts without an answer', () => {
  const dir = folder({ '3.answer': 'stale\n' });
  ws.saveTest(dir, '3', '1 2\n');
  assert.equal(fs.readFileSync(path.join(dir, '3.in'), 'utf8'), '1 2\n');
  assert.equal(fs.existsSync(path.join(dir, '3.answer')), false);
});

test('a folder that disappeared lists as empty', () => {
  const gone = path.join(folder({}), 'gone');
  assert.deepEqual(ws.solutionsIn(gone), []);
  assert.deepEqual(ws.testIds(gone), []);
  assert.deepEqual(ws.othersIn(gone), []);
  assert.deepEqual(ws.problemsIn(gone), []);
});
