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

test.use({ files: { 'sum/sum.cpp': SUM } });

test('Run compiles the solution, takes typed input and shows the output', async ({ editor }) => {
  await editor.toolbar.getByRole('button', { name: /^Run/ }).click();

  const input = editor.panel.getByRole('textbox', { name: 'Input for the program' });
  await input.fill('12 9');
  await input.press('Enter');

  const run = editor.panel.locator('details[data-key="run"]');
  await expect(run.locator('pre')).toHaveText('12 9\n21\n');
  await expect(run.getByRole('img', { name: 'Finished' })).toBeVisible();
  expect(fs.existsSync(path.join(editor.workspace, 'sum/.cp/sum', process.platform === 'win32' ? 'run.exe' : 'run'))).toBe(true);
});
