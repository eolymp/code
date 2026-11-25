const fs = require('fs');
const path = require('path');
const { test, expect } = require('./app');

test.use({ files: { 'sum/sum.cpp': 'int main() {}\n', 'sum/notes.txt': 'notes\n', 'sum/1.in': '1\n', 'sum/1.answer': '1\n', 'zeta/zeta.cpp': 'int main() {}\n', 'zeta/big.in': '1\n', 'zeta/007.in': '1\n' } });

test('The Practice view deletes, renames and undoes with the keyboard', async ({ editor }) => {
  const { tree, there } = editor;
  const row = (name) => tree.getByRole('treeitem', { name });
  const rows = (...names) => expect(tree.getByRole('treeitem')).toHaveText(names);
  const press = (key) => editor.window.keyboard.press(key);
  const remove = process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete';
  const [undo, redo] = process.platform === 'darwin' ? ['Meta+z', 'Meta+Shift+z'] : ['Control+z', process.platform === 'win32' ? 'Control+y' : 'Control+Shift+z'];
  const zeta = ['zeta', 'Test 007', 'Test "big"', 'zeta.cpp'];
  await rows('sum', 'Test 1', 'sum.cpp', 'notes.txt', ...zeta);
  await expect(row('sum.cpp')).toHaveAttribute('aria-selected', 'true');

  await editor.select(row('sum.cpp'));
  await press('ArrowDown');
  await expect(row('sum.cpp')).toHaveAttribute('aria-selected', 'true');
  await press(remove);
  await expect(editor.window.getByText("Are you sure you want to delete 'notes.txt'?")).toBeVisible();
  await editor.window.getByRole('button', { name: 'Cancel' }).click();

  await editor.select(row('notes.txt'));
  await row('Test 1').click({ modifiers: ['ControlOrMeta'] });
  await press(remove);
  await editor.window.getByRole('button', { name: /^Move to/ }).click();
  await rows('sum', 'sum.cpp', ...zeta);
  expect(there('sum/notes.txt') || there('sum/1.in') || there('sum/1.answer')).toBe(false);

  await editor.select(row('sum.cpp'));
  await press(process.platform === 'darwin' ? 'Enter' : 'F2');
  await expect(editor.box).toHaveValue('sum.cpp');
  await editor.answer('New name of the solution', 'main');
  await rows('sum', 'main.cpp', ...zeta);
  expect(there('sum/main.cpp') && !there('sum/sum.cpp')).toBe(true);

  await editor.select(row('main.cpp'));
  await press(undo);
  await rows('sum', 'sum.cpp', ...zeta);
  await editor.select(row('sum.cpp'));
  await press(undo);
  await rows('sum', 'Test 1', 'sum.cpp', 'notes.txt', ...zeta);
  expect(editor.read('sum/notes.txt')).toBe('notes\n');
  expect(editor.read('sum/1.answer')).toBe('1\n');
  await editor.select(row('notes.txt'));
  await press(redo);
  await rows('sum', 'sum.cpp', ...zeta);

  await editor.select(row(/^sum,/));
  await press(remove);
  await editor.window.getByRole('button', { name: /^Move to/ }).click();
  await rows(...zeta);
  expect(there('sum')).toBe(false);
  await editor.select(row('zeta.cpp'));
  await press(undo);
  await expect.poll(() => there('sum') && fs.readdirSync(path.join(editor.workspace, 'sum'))).toEqual([]);
});

test('The Practice view copies, cuts and pastes with the keyboard', async ({ editor }) => {
  const { tree, there } = editor;
  const row = (name) => tree.getByRole('treeitem', { name });
  const rows = (...names) => expect(tree.getByRole('treeitem')).toHaveText(names);
  const key = (letter) => editor.window.keyboard.press(`ControlOrMeta+${letter}`);
  await rows('sum', 'Test 1', 'sum.cpp', 'notes.txt', 'zeta', 'Test 007', 'Test "big"', 'zeta.cpp');
  await expect(row('sum.cpp')).toHaveAttribute('aria-selected', 'true');

  await editor.select(row('sum.cpp'));
  await key('c');
  await key('v');
  await rows('sum', 'Test 1', 'sum.cpp', 'sum copy.cpp', 'notes.txt', 'zeta', 'Test 007', 'Test "big"', 'zeta.cpp');

  await editor.select(row('Test 1'));
  await expect(editor.window.getByRole('tab', { name: /^1\.in/ })).toHaveAttribute('aria-selected', 'true');
  await expect(row('Test 1')).toHaveAttribute('aria-selected', 'true');
  await key('c');
  await editor.select(row('zeta.cpp'));
  await key('v');
  await rows('sum', 'Test 1', 'sum.cpp', 'sum copy.cpp', 'notes.txt', 'zeta', 'Test 1', 'Test 007', 'Test "big"', 'zeta.cpp');
  expect(there('zeta/1.in') && there('zeta/1.answer') && there('sum/1.in')).toBe(true);

  await editor.select(row('notes.txt'));
  await key('x');
  await editor.select(row('zeta.cpp'));
  await key('v');
  await rows('sum', 'Test 1', 'sum.cpp', 'sum copy.cpp', 'zeta', 'Test 1', 'Test 007', 'Test "big"', 'zeta.cpp', 'notes.txt');

  await editor.select(row(/^sum,/));
  await key('c');
  await key('v');
  await rows('sum', 'sum-copy', 'Test 1', 'sum-copy.cpp', 'sum copy.cpp', 'zeta', 'Test 1', 'Test 007', 'Test "big"', 'zeta.cpp', 'notes.txt');
  expect(there('sum-copy/sum-copy.cpp') && there('sum-copy/1.answer')).toBe(true);
});

test('The Practice view creates problems, solutions, tests and files, and renames them', async ({ editor }) => {
  const { tree, box, there } = editor;
  const row = (name) => tree.getByRole('treeitem', { name });
  const rows = (...names) => expect(tree.getByRole('treeitem')).toHaveText(names);
  const tab = (name) => editor.window.getByRole('tab', { name });
  const rename = process.platform === 'darwin' ? 'Enter' : 'F2';
  const before = ['sum', 'Test 1', 'sum.cpp', 'notes.txt'];
  const zeta = ['zeta', 'Test 007', 'Test "big"', 'zeta.cpp'];
  await rows(...before, ...zeta);

  await editor.window.getByRole('button', { name: 'New Problem Workspace' }).click();
  await editor.answer('Name of the problem', 'Two Sum');
  await rows(...before, 'two-sum', 'two-sum.cpp', ...zeta);
  await expect(tab(/^two-sum\.cpp/)).toHaveAttribute('aria-selected', 'true');
  await expect(row(/^two-sum\.cpp/)).toHaveAttribute('aria-selected', 'true');
  expect(editor.read('two-sum/two-sum.cpp')).toContain('int main() {');

  await row(/^two-sum,/).hover();
  await row(/^two-sum,/).getByRole('button', { name: 'New Solution' }).click();
  await expect(box).toHaveValue('brute.cpp');
  await editor.answer('Name of the solution', 'slow.py');
  await rows(...before, 'two-sum', 'two-sum.cpp', 'slow.py', ...zeta);
  await expect(row(/^slow\.py/)).toHaveAttribute('aria-selected', 'true');
  expect(editor.read('two-sum/slow.py')).toContain('import sys');

  await row(/^two-sum,/).hover();
  await row(/^two-sum,/).getByRole('button', { name: 'New Test' }).click();
  await rows(...before, 'two-sum', 'Test 1', '1.in', 'two-sum.cpp', 'slow.py', ...zeta);
  await expect(tab(/^1\.in/)).toHaveAttribute('aria-selected', 'true');

  await row(/^two-sum,/).click({ button: 'right' });
  await editor.pick('New File');
  await editor.answer('Name of the file', 'notes.md');
  await rows(...before, 'two-sum', 'Test 1', '1.in', 'two-sum.cpp', 'slow.py', 'notes.md', ...zeta);
  await expect(row(/^notes\.md/)).toHaveAttribute('aria-selected', 'true');

  await editor.select(row(/^Test 1/).last());
  await editor.window.keyboard.press(rename);
  await expect(box).toHaveValue('1');
  await editor.answer('New name of the test', 'big');
  await expect(row(/^Test "big"/)).toHaveCount(2);
  expect(there('two-sum/big.in') && !there('two-sum/1.in')).toBe(true);

  await editor.select(row(/^two-sum,/));
  await editor.window.keyboard.press(rename);
  await expect(box).toHaveValue('two-sum');
  await editor.answer('New name of the problem', 'Pair');
  await expect(row(/^pair,/)).toBeVisible();
  expect(there('pair/pair.cpp') && there('pair/slow.py') && there('pair/big.in') && !there('two-sum')).toBe(true);
});
