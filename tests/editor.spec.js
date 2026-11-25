const { test, expect } = require('./app');

const BROKEN = '#include <bits/stdc++.h>\nint main() {\n    std::cout << missing;\n}\n';
const MESSY = '#include <bits/stdc++.h>\nint main(){int a=1;int unused;\nreturn a;}\n';

test.use({ files: { 'sum/sum.cpp': BROKEN, 'sum/sum.py': 'print(missing)\n', 'sum/messy.cpp': MESSY } });

test('Mistakes are underlined in C++ and Python, and counted in the Practice view', async ({ editor }) => {
  const { window, tree } = editor;
  await expect(window.locator('.monaco-editor .squiggly-error')).toHaveCount(1, { timeout: 60000 });
  await expect(tree.getByRole('treeitem', { name: /^sum\.cpp/ }).locator('.monaco-decoration-badge')).toBeVisible();

  await tree.getByRole('treeitem', { name: /^sum\.py/ }).click();
  await expect(window.getByRole('tab', { name: /^sum\.py/ })).toHaveAttribute('aria-selected', 'true');
  await expect(window.locator('.monaco-editor .squiggly-error')).toHaveCount(1, { timeout: 60000 });
});

test('Completion offers standard library names, and saving formats the file', async ({ editor }) => {
  const { window, tree } = editor;
  await tree.getByRole('treeitem', { name: /^messy\.cpp/ }).click();
  await expect(window.getByRole('tab', { name: /^messy\.cpp/ })).toHaveAttribute('aria-selected', 'true');
  await window.locator('.monaco-editor .view-lines').first().click();
  await window.keyboard.press('ControlOrMeta+End');
  await expect(window.locator('.monaco-editor .squiggly-warning').first()).toBeVisible({ timeout: 60000 });
  await window.keyboard.type('std::vec');
  await expect(window.locator('.suggest-widget .monaco-list-row').filter({ hasText: 'vector' }).first()).toBeVisible();
  await window.keyboard.press('Escape');
  for (let i = 0; i < 8; i += 1) await window.keyboard.press('Backspace');

  await window.keyboard.press('ControlOrMeta+s');
  await expect.poll(() => editor.read('sum/messy.cpp')).toContain('int main() {\n');
  expect(editor.read('sum/messy.cpp')).toContain('int a = 1;');
});
