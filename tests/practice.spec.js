const fs = require('fs');
const path = require('path');
const { test, expect } = require('./app');

test.use({
  files: { 'sum/sum.cpp': 'int main() {}\n', 'sum/notes.txt': 'notes\n', 'sum/1.in': '1\n', 'sum/1.answer': '1\n', 'zeta/zeta.cpp': 'int main() {}\n', 'zeta/big.in': '1\n', 'zeta/007.in': '1\n' },
  settings: { 'window.dialogStyle': 'custom' },
});

test('The Practice view deletes, renames and undoes with the keyboard', async ({ editor }) => {
  const tree = editor.window.getByRole('tree', { name: 'Practice' });
  const there = (file) => fs.existsSync(path.join(editor.workspace, file));
  await expect(tree.getByRole('treeitem', { name: 'sum.cpp' })).toHaveAttribute('aria-selected', 'true');

  await tree.getByRole('treeitem', { name: 'sum.cpp' }).click();
  await editor.window.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: 'sum.cpp' })).toHaveAttribute('aria-selected', 'true');
  await editor.window.keyboard.press(process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete');
  await expect(editor.window.getByText("Are you sure you want to delete 'notes.txt'?")).toBeVisible();
  await editor.window.getByRole('button', { name: 'Cancel' }).click();

  await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
  await tree.getByRole('treeitem', { name: 'Test 1' }).click({ modifiers: ['ControlOrMeta'] });
  await editor.window.keyboard.press(process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete');
  await editor.window.getByRole('button', { name: /^Move to/ }).click();
  await expect.poll(() => there('sum/notes.txt') || there('sum/1.in') || there('sum/1.answer')).toBe(false);

  await tree.getByRole('treeitem', { name: 'sum.cpp' }).click();
  await editor.window.keyboard.press(process.platform === 'darwin' ? 'Enter' : 'F2');
  const box = editor.window.locator('.quick-input-widget input[type="text"]');
  await expect(box).toHaveValue('sum.cpp');
  await box.fill('main');
  await box.press('Enter');
  await expect.poll(() => there('sum/main.cpp') && !there('sum/sum.cpp')).toBe(true);

  const [undo, redo] = process.platform === 'darwin' ? ['Meta+z', 'Meta+Shift+z'] : ['Control+z', process.platform === 'win32' ? 'Control+y' : 'Control+Shift+z'];
  await tree.getByRole('treeitem', { name: 'main.cpp' }).click();
  await editor.window.keyboard.press(undo);
  await expect.poll(() => there('sum/sum.cpp') && !there('sum/main.cpp')).toBe(true);
  await tree.getByRole('treeitem', { name: 'sum.cpp' }).click();
  await editor.window.keyboard.press(undo);
  await expect.poll(() => there('sum/notes.txt') && there('sum/1.in') && there('sum/1.answer')).toBe(true);
  expect(fs.readFileSync(path.join(editor.workspace, 'sum/notes.txt'), 'utf8')).toBe('notes\n');
  await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
  await editor.window.keyboard.press(redo);
  await expect.poll(() => there('sum/notes.txt') || there('sum/1.in')).toBe(false);

  await tree.getByRole('treeitem').first().click();
  await editor.window.keyboard.press(process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete');
  await editor.window.getByRole('button', { name: /^Move to/ }).click();
  await expect.poll(() => there('sum')).toBe(false);
  await tree.getByRole('treeitem', { name: 'zeta.cpp' }).click();
  await editor.window.keyboard.press(undo);
  await expect.poll(() => there('sum') && fs.statSync(path.join(editor.workspace, 'sum')).isDirectory()).toBe(true);
  expect(fs.readdirSync(path.join(editor.workspace, 'sum'))).toEqual([]);
});

test('The Practice view copies, cuts and pastes with the keyboard', async ({ editor }) => {
  const tree = editor.window.getByRole('tree', { name: 'Practice' });
  const there = (file) => fs.existsSync(path.join(editor.workspace, file));
  const key = (letter) => editor.window.keyboard.press(`ControlOrMeta+${letter}`);

  await expect(tree.getByRole('treeitem', { name: /^Test "big"/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: /^Test 007/ })).toBeVisible();

  await tree.getByRole('treeitem', { name: 'sum.cpp' }).click();
  await key('c');
  await key('v');
  await expect.poll(() => there('sum/sum copy.cpp')).toBe(true);

  await tree.getByRole('treeitem', { name: 'Test 1' }).click();
  await expect(editor.window.getByRole('tab', { name: /^1\.in/ })).toBeVisible();
  await expect(tree.getByRole('treeitem', { name: 'Test 1' })).toHaveAttribute('aria-selected', 'true');
  await key('c');
  await tree.getByRole('treeitem', { name: 'zeta.cpp' }).click();
  await key('v');
  await expect.poll(() => there('zeta/1.in') && there('zeta/1.answer') && there('sum/1.in')).toBe(true);

  await tree.getByRole('treeitem', { name: 'notes.txt' }).click();
  await key('x');
  await tree.getByRole('treeitem', { name: 'zeta.cpp' }).click();
  await key('v');
  await expect.poll(() => there('zeta/notes.txt') && !there('sum/notes.txt')).toBe(true);
  await key('z');
  await expect.poll(() => there('sum/notes.txt') && !there('zeta/notes.txt')).toBe(true);

  await tree.getByRole('treeitem').first().click();
  await key('c');
  await key('v');
  await expect.poll(() => there('sum-copy/sum-copy.cpp') && there('sum-copy/1.in')).toBe(true);
});
