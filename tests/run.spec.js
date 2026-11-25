const fs = require('fs');
const path = require('path');
const { test, expect } = require('./app');

const SUM = `#include <bits/stdc++.h>
using namespace std;

int main() {
    int a, b;
    cin >> a >> b;
    cout << a + b << '\\n';
    return 0;
}
`;

test.use({ files: { 'sum/sum.cpp': SUM, 'sum/1.in': '1 2\n' } });

test('Run compiles the solution, takes typed input and shows the output', async ({ editor }) => {
  await editor.toolbar.getByRole('button', { name: /^Run/ }).click();

  const input = editor.panel.getByRole('textbox', { name: 'Input for the program' });
  await input.fill('12 9');
  await input.press('Enter');

  const run = editor.panel.locator('details[data-key="run"]');
  await expect(run.locator('pre')).toHaveText('12 9\n21\n');
  await expect(run.getByRole('img', { name: 'Finished' })).toBeVisible();
  expect(fs.existsSync(path.join(editor.workspace, 'sum/.build/sum', process.platform === 'win32' ? 'run.exe' : 'run'))).toBe(true);
});

test('F5 runs the solution from a test file and from the Practice view', async ({ editor }) => {
  const title = editor.panel.locator('details[data-key="compile"] .title');
  await editor.window.getByRole('treeitem', { name: 'Test 1' }).click();
  await expect(editor.window.getByRole('tab', { name: /^1\.in/ })).toBeVisible();
  await editor.window.keyboard.press('F5');
  await expect(title).toContainText('sum.cpp');
  const input = editor.panel.getByRole('textbox', { name: 'Input for the program' });
  await expect(input).toBeFocused();
  await editor.window.keyboard.type('12 9');
  await editor.window.keyboard.press('Enter');
  await expect(editor.panel.locator('details[data-key="run"] pre')).toHaveText('12 9\n21\n');
  await editor.window.waitForTimeout(500);
  await expect(editor.window.locator('.quick-input-widget')).toBeHidden();

  await editor.window.locator('.monaco-editor .view-lines').first().click();
  await editor.window.keyboard.press('Shift+F5');
  await expect(editor.panel.locator('details[data-key="test-1"]')).toBeVisible();
});
