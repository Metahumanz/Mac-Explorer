import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-cut-keys-'));
for (const folder of ['Documents', 'Desktop', 'Downloads']) await fs.mkdir(path.join(root, folder));
const docs = path.join(root, 'Documents');
await fs.mkdir(path.join(docs, '目标'));
await fs.writeFile(path.join(docs, '原文件.txt'), 'cut me');
const flags = (process.env.EXPLORER_SMOKE_ARGS || '').split(' ').filter(Boolean);
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: flags } : { args: [process.cwd(), ...flags] }), env: { ...process.env, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_ROOT: root } });
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const row = name => page.getByRole('option', { name, exact: true });

  // The application menu must still carry the Command+X accelerator for cut.
  const menuHasCut = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    if (!menu) return false;
    return menu.items.flatMap(top => top.submenu?.items ?? []).some(item => item.accelerator === 'Command+X');
  });
  assert.equal(menuHasCut, true, 'Edit menu must keep a Command+X item');

  // Command+X on a selected row marks the clipboard as a cut.
  await row('原文件.txt').click();
  await page.keyboard.press('Meta+x');
  await page.waitForFunction(async () => {
    const clip = await window.explorer.clipboardGet();
    return clip.cut === true && clip.paths.some(p => p.endsWith('原文件.txt'));
  });
  await page.locator('.file-row.cut').waitFor();

  // Pasting in another folder moves the file (and clears the cut highlight state).
  await row('目标').click(); await page.keyboard.press('Meta+ArrowDown');
  await page.getByText('此文件夹为空', { exact: true }).waitFor();
  await page.keyboard.press('Meta+v'); await row('原文件.txt').waitFor();
  await assert.rejects(fs.access(path.join(docs, '原文件.txt')));
  assert.equal(await fs.readFile(path.join(docs, '目标', '原文件.txt'), 'utf8'), 'cut me');
  console.log('PASS: Edit menu keeps Command+X; Meta+x cuts a selected row (clipboard cut=true, row highlighted) and Meta+v moves it.');
} finally {
  await app.close(); await fs.rm(root, { recursive: true, force: true });
}
