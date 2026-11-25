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

test('Ctrl+F5 on a test runs that test and F6 runs them all', async ({ editor }) => {
  await editor.window.getByRole('treeitem', { name: 'Test 1' }).click();
  await expect(editor.window.getByRole('tab', { name: /^1\.in/ })).toBeVisible();
  await editor.window.keyboard.press('Control+F5');
  await expect(editor.panel.locator('details[data-key="compile"] .title')).toContainText('sum.cpp');
  await expect(editor.panel.locator('details[data-key="test-1"] pre')).toHaveText('3\n');

  await editor.window.locator('.monaco-editor .view-lines').first().click();
  await editor.window.keyboard.press('Control+F5');
  await expect(editor.panel.locator('details[data-key="test-1"] pre')).toHaveText('3\n');
  await editor.window.keyboard.press('F6');
  await expect(editor.panel.locator('details[data-key="test-1"]')).toBeVisible();
});

test('A compilation error shows short paths that open the place', async ({ editor }) => {
  fs.writeFileSync(path.join(editor.workspace, 'sum/sum.cpp'), SUM.replace('cout <<', 'cfout <<'));
  await editor.toolbar.getByRole('button', { name: /^Run/ }).click();

  const log = editor.panel.locator('details[data-key="compile"] pre');
  await expect(log.getByRole('link').first()).toHaveText('sum/sum.cpp:7:5');
  await expect(log).not.toContainText(editor.workspace);
});

test.describe('Python', () => {
  test.use({ files: { 'sum/sum.py': 'import json\njson.loads("x")\n' } });

  test('A traceback shows short paths that open the place', async ({ editor }) => {
    await editor.toolbar.getByRole('button', { name: /^Run/ }).click();

    const log = editor.panel.locator('details[data-key="run"] pre');
    await expect(log.getByRole('link').first()).toHaveText('sum/sum.py');
    await expect(log).toContainText('File "stdlib:json/__init__.py", line');
    await expect(log).not.toContainText(editor.workspace);
  });
});
