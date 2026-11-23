const { test, expect } = require('./app');

test.use({ files: { 'sum/sum.cpp': '#include <bits/stdc++.h>\nint main() { int a, b; std::cin >> a >> b; std::cout << a + b << "\\n"; }\n' }, tools: false });
test.setTimeout(900000);

test('A first launch offers to install the compiler and Python, and Run works afterwards', async ({ editor }) => {
  await editor.window.getByRole('button', { name: 'Install' }).click();
  await expect(editor.window.getByText('Eolymp Code is ready.').first()).toBeVisible({ timeout: 800000 });

  await editor.toolbar.getByRole('button', { name: /^Run/ }).click();
  const input = editor.panel.getByRole('textbox', { name: 'Input for the program' });
  await input.fill('12 9');
  await input.press('Enter');
  await expect(editor.panel.locator('details[data-key="run"] pre')).toHaveText('12 9\n21\n');
  await expect(editor.panel.locator('details[data-key="compile"] .title')).toContainText('g++');

  await editor.window.keyboard.press('ControlOrMeta+Shift+P');
  await editor.window.keyboard.type('Eolymp Code: Diagnostics');
  await editor.window.keyboard.press('Enter');
  await expect(editor.page.locator('.step', { hasText: 'C++ program runs' }).locator('.mark.ok')).toBeVisible({ timeout: 60000 });
  await expect(editor.page.locator('.step', { hasText: 'Time and memory measuring' }).locator('.mark.ok')).toBeVisible();
  if (process.env.SHOT) await editor.window.screenshot({ path: process.env.SHOT });
});
