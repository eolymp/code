const { test, expect } = require('./app');

const SQUARE = 'n = int(input())\nif n < 0:\n    raise ValueError("negative")\nprint(n * n)\n';

test.use({ files: { 'square/square.py': SQUARE, 'square/1.in': '7\n', 'square/1.answer': '49\n', 'square/2.in': '-1\n', 'square/2.answer': '1\n' } });

test('A Python solution runs, is tested and shows its exception', async ({ editor }) => {
  await editor.toolbar.getByRole('button', { name: /^Run/ }).click();
  const input = editor.panel.getByRole('textbox', { name: 'Input for the program' });
  await input.fill('12');
  await input.press('Enter');
  const run = editor.panel.locator('details[data-key="run"]');
  await expect(run.locator('pre')).toHaveText('12\n144\n');
  await expect(run.locator('.title')).toContainText('square.py');
  await expect(editor.panel.locator('details[data-key="compile"]')).toHaveCount(0);

  await editor.toolbar.getByRole('button', { name: /^Test/ }).click();
  const card = (id) => editor.panel.locator(`details[data-key="test-${id}"]`);
  await expect(card(1).getByRole('img', { name: 'The output matches the answer' })).toBeVisible();
  await expect(card(2).getByRole('img', { name: 'runtime error' })).toBeVisible();
  await expect(card(2).locator('pre')).toContainText('ValueError: negative');
});
