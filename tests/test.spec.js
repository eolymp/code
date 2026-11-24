const fs = require('fs');
const path = require('path');
const { test, expect } = require('./app');

const LINES = `#include <bits/stdc++.h>
using namespace std;

int main() {
    int n;
    cin >> n;
    for (int i = 0; i < n; i++) cout << "line\\n";
    return 0;
}
`;

test.use({ files: { 'lines/lines.cpp': LINES, 'lines/1.in': '2\n', 'lines/1.answer': 'line\nline\n', 'lines/2.in': '100000\n' } });

test('Test compares each output with its answer and keeps long output in a file', async ({ editor }) => {
  await editor.toolbar.getByRole('button', { name: /^Test/ }).click();

  const first = editor.panel.locator('details[data-key="test-1"]');
  await expect(first.getByRole('img', { name: 'The output matches the answer' })).toBeVisible();

  const second = editor.panel.locator('details[data-key="test-2"]');
  await expect(second.getByRole('img', { name: 'No answer to compare with' })).toBeVisible();
  await expect(second.getByText('Output trimmed, open 2.out')).toBeVisible();
  expect(fs.statSync(path.join(editor.workspace, 'lines/.cp/lines/2.out')).size).toBe(500000);
});
