const { test, expect } = require('./app');

const LAUNCH = {
  version: '0.2.0',
  configurations: [{ name: 'sum', type: 'lldb', request: 'launch', program: '${workspaceFolder}/sum/.build/sum/run' }],
};

test.use({
  files: {
    'sum/sum.cpp': '#include <bits/stdc++.h>\nint main() {\n  int a, b;\n  std::cin >> a >> b;\n  std::cout << a + b << "\\n";\n}\n',
    'sum/1.in': '1 2\n',
    '.vscode/launch.json': JSON.stringify(LAUNCH),
  },
});

test('The debugger starts a compiled solution', async ({ editor }) => {
  await editor.toolbar.getByRole('button', { name: /^Run/ }).click();
  await expect(editor.panel.locator('details[data-key="compile"] .title')).toContainText('sum.cpp');
  await editor.toolbar.getByRole('button', { name: /^Stop/ }).click();

  await editor.window.keyboard.press('ControlOrMeta+Shift+P');
  await editor.window.keyboard.type('Debug: Select and Start Debugging');
  await editor.window.keyboard.press('Enter');
  await editor.window.getByRole('option', { name: /^sum/ }).click();
  await expect(editor.window.getByRole('button', { name: /^Pause/ })).toBeVisible({ timeout: 60000 });
  await expect(editor.window.getByText('Launching:')).toBeVisible();
});

test('F5 debugs the solution with typed input', async ({ editor }) => {
  await editor.window.locator('.monaco-editor .view-lines').first().click();
  await editor.window.keyboard.press('F5');
  await editor.window.getByRole('button', { name: /^Continue/ }).click({ timeout: 60000 });

  const input = editor.panel.getByRole('textbox', { name: 'Input for the program' });
  await input.fill('12 9');
  await input.press('Enter');
  const run = editor.panel.locator('details[data-key="run"]');
  await expect(run.locator('pre')).toHaveText('12 9\n21\n');
  await expect(run.getByRole('img', { name: 'Finished' })).toBeVisible();
  await expect(editor.window.getByRole('tab', { name: /^Terminal/ })).not.toHaveAttribute('aria-selected', 'true');
});

test('F5 on a test file debugs the solution on that test', async ({ editor }) => {
  await editor.window.getByRole('treeitem', { name: 'Test 1' }).click();
  await expect(editor.window.getByRole('tab', { name: /^1\.in/ })).toBeVisible();
  await editor.window.keyboard.press('F5');
  await editor.window.getByRole('button', { name: /^Continue/ }).click({ timeout: 60000 });

  const run = editor.panel.locator('details[data-key="run"]');
  await expect(run.locator('.title')).toContainText('< 1.in');
  await expect(run.locator('pre')).toHaveText('3\n');
  await expect(run.getByRole('img', { name: 'Finished' })).toBeVisible();
});

test('Stop ends a debug session', async ({ editor }) => {
  await editor.window.locator('.monaco-editor .view-lines').first().click();
  await editor.window.keyboard.press('F5');
  await expect(editor.window.getByRole('button', { name: /^Continue/ })).toBeVisible({ timeout: 60000 });
  await editor.toolbar.getByRole('button', { name: /^Stop/ }).click();
  await expect(editor.panel.locator('details[data-key="run"]').getByRole('img', { name: 'Stopped' })).toBeVisible();
});
