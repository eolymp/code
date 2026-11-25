const fs = require('fs');
const path = require('path');
const { test, expect } = require('./app');

const BROKEN = '#include <bits/stdc++.h>\nint main() {\n    int total = 0\n    std::cout << total;\n}\n';
const WARNS = '#include <bits/stdc++.h>\nint main() {\n    int unused;\n    std::cout << 1;\n}\n';
const FAILS = `#include <bits/stdc++.h>
int main() {
    int n;
    std::cin >> n;
    if (n == 1) return 3;
    if (n == 2) std::raise(SIGTERM);
    std::cerr << "careful\\n";
    std::cout << n << "\\n";
}
`;
const SUMS = '#include <bits/stdc++.h>\nint main() {\n    long long x, total = 0;\n    while (std::cin >> x) total += x;\n    std::cout << total << "\\n";\n}\n';

test.describe('compiling', () => {
  test.use({ files: { 'sum/sum.cpp': BROKEN, 'sum/warns.cpp': WARNS } });

  test('A compile error links to its line, and warnings do not stop the run', async ({ editor }) => {
    const compile = editor.panel.locator('details[data-key="compile"]');
    await editor.toolbar.getByRole('button', { name: /^Run/ }).click();
    await expect(compile.getByRole('img', { name: 'Compilation failed' })).toBeVisible();
    await expect(compile.locator('pre.bad')).toContainText('error');
    await expect(editor.panel.locator('details[data-key="run"]')).toHaveCount(0);

    await editor.window.keyboard.press('ControlOrMeta+End');
    await compile.locator('pre a').first().click();
    await expect(editor.window.locator('#status\\.editor\\.selection')).toContainText(/Ln [34],/);

    await editor.tree.getByRole('treeitem', { name: /^warns\.cpp/ }).click();
    await expect(editor.window.getByRole('tab', { name: /^warns\.cpp/ })).toHaveAttribute('aria-selected', 'true');
    await editor.toolbar.getByRole('button', { name: /^Run/ }).click();
    await expect(compile.getByRole('img', { name: 'Compiled with warnings' })).toBeVisible();
    await expect(compile.locator('pre')).toContainText('unused');
    await expect(editor.panel.locator('details[data-key="run"]').getByRole('img', { name: 'Finished' })).toBeVisible();
  });
});

test.describe('failing programs', () => {
  test.use({ files: { 'fails/fails.cpp': FAILS, 'fails/1.in': '1\n', 'fails/1.answer': '1\n', 'fails/2.in': '2\n', 'fails/2.answer': '2\n', 'fails/3.in': '3\n', 'fails/3.answer': '3\n' } });

  test('Test shows an exit code, a crash and what the program wrote to stderr', async ({ editor }) => {
    await editor.toolbar.getByRole('button', { name: /^Test/ }).click();
    const card = (id) => editor.panel.locator(`details[data-key="test-${id}"]`);
    await expect(card(1).getByRole('img', { name: 'runtime error' })).toBeVisible();
    await expect(card(1)).toContainText('Exit code 3');
    await expect(card(2)).toContainText(process.platform === 'win32' ? 'Exit code' : 'Crashed (SIGTERM)');
    await expect(card(3).getByRole('img', { name: 'The output matches the answer' })).toBeVisible();
    await expect(card(3).locator('pre')).toHaveText('3\ncareful\n');
    await expect(editor.panel.locator('#head')).toContainText('1/3 match');
  });
});

test.describe('a run', () => {
  test.use({ files: { 'sums/sums.cpp': SUMS, 'sums/1.in': '1 2\n' } });

  test('End input finishes a run, Stop ends one, and a run becomes a test', async ({ editor }) => {
    const head = editor.panel.locator('#head');
    const run = editor.panel.locator('details[data-key="run"]');
    const input = editor.panel.getByRole('textbox', { name: 'Input for the program' });
    await editor.toolbar.getByRole('button', { name: /^Run/ }).click();
    await input.fill('5');
    await input.press('Enter');
    await input.fill('7');
    await input.press('Enter');
    await head.getByRole('button', { name: /^End input/ }).click();
    await expect(run.locator('pre')).toHaveText('5\n7\n12\n');
    await expect(run.getByRole('img', { name: 'Finished' })).toBeVisible();

    await run.getByRole('button', { name: 'More actions' }).click();
    await editor.pick('Add as Test');
    await expect.poll(() => editor.there('sums/2.in') && editor.read('sums/2.in')).toBe('5\n7\n');
    expect(editor.read('sums/2.out')).toBe('12\n');

    await head.getByRole('button', { name: 'Rerun' }).click();
    await expect(input).toBeVisible();
    await head.getByRole('button', { name: /^Stop/ }).click();
    await expect(run.getByRole('img', { name: 'Stopped' })).toBeVisible();
    await expect(head.getByRole('button', { name: 'Rerun' })).toBeVisible();
  });

  test('An output becomes the answer, an edited answer is judged again, and the difference opens', async ({ editor }) => {
    const first = editor.panel.locator('details[data-key="test-1"]');
    await editor.toolbar.getByRole('button', { name: /^Test/ }).click();
    await expect(first.getByRole('img', { name: 'No answer to compare with' })).toBeVisible();

    await first.locator('summary .title').click({ button: 'right' });
    await editor.pick('Use Output as Answer');
    await expect(first.getByRole('img', { name: 'The output matches the answer' })).toBeVisible();
    expect(editor.read('sums/1.answer')).toBe('3\n');

    fs.writeFileSync(path.join(editor.workspace, 'sums/1.answer'), '4\n');
    await expect(first.getByRole('img', { name: 'The output differs from the answer' })).toBeVisible();
    await first.locator('summary .title').click({ button: 'right' });
    await editor.pick('Show Diff');
    await expect(editor.window.getByRole('tab', { name: /answer ↔ output of sums\.cpp/ })).toBeVisible();
  });
});
