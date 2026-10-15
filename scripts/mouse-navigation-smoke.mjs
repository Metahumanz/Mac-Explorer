import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-mouse-nav-'));
for (const folder of ['Documents/A/B', 'Desktop', 'Downloads']) await fs.mkdir(path.join(root, folder), { recursive: true });
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const content = page.locator('.file-content');
  const at = async name => page.locator(`.file-content[aria-label="${name}"][aria-busy="false"]`).waitFor();
  const unchanged = async name => { await page.waitForTimeout(150); assert.equal(await content.getAttribute('aria-label'), name); };
  // Playwright only presses left/middle/right; CDP drives Chromium's native back/forward button input.
  const cdp = await page.context().newCDPSession(page);
  const press = async (button, selector = '.file-content') => {
    const box = await page.locator(selector).first().boundingBox();
    const point = { x: box.x + box.width / 2, y: box.y + box.height / 2, button, clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
  };
  await page.getByRole('option', { name: 'A', exact: true }).dblclick(); await at('A');
  await page.getByRole('option', { name: 'B', exact: true }).dblclick(); await at('B');
  await press('back'); await at('A');
  await press('back'); await at('文档');
  await press('back'); await unchanged('文档'); // Start of history.
  await press('forward'); await at('A');
  await press('forward', '.sidebar'); await at('B'); // Works outside the file list.
  await press('forward'); await unchanged('B'); // End of history.
  await page.keyboard.press('Meta+Shift+g');
  await press('back'); await unchanged('B');
  await page.getByRole('textbox', { name: '文件夹地址', exact: true }).press('Escape');
  await content.click({ button: 'right' });
  await press('back'); await unchanged('B');
  await page.keyboard.press('Escape');
  await press('back'); await at('A');
  console.log('PASS: mouse back/forward buttons, history bounds, address and menu guards. Physical mouse buttons require manual verification.');
} finally {
  await app.close(); await fs.rm(root, { recursive: true, force: true });
}
