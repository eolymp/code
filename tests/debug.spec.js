const { test, expect } = require('./app');

const LAUNCH = {
  version: '0.2.0',
  configurations: [{ name: 'sum', type: 'lldb', request: 'launch', program: '${workspaceFolder}/sum/.cp/sum/run' }],
};

test.use({
  files: {
    'sum/sum.cpp': '#include <bits/stdc++.h>\nint main() {\n  int a, b;\n  std::cin >> a >> b;\n  std::cout << a + b << "\\n";\n}\n',
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
