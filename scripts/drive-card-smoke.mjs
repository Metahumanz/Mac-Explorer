import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-drive-card-'));
await fs.mkdir(path.join(root, 'Documents'));
await fs.mkdir('artifacts', { recursive: true });
const app = await electron.launch({ colorScheme: null, args: [process.cwd()], env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN' } });
const page = await app.firstWindow();
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const computer = () => page.locator('.sidebar').getByRole('button', { name: '此电脑', exact: true }).click();
try {
  await page.locator('.file-content[aria-busy=false]').waitFor();
  const boot = await page.evaluate(() => window.explorer.bootstrap());
  // Fixed capacities for visual comparison; keep the real system volume icon.
  const volume = { ...boot.volumes.find(volume => volume.path === '/'), name: 'Macintosh HD', path: '/', total: 460.4 * 1024 ** 3, free: 99.6 * 1024 ** 3, canEject: false };
  await app.evaluate(({ ipcMain }, boot) => {
    ipcMain.removeHandler('bootstrap'); ipcMain.handle('bootstrap', () => boot);
    ipcMain.removeHandler('volumes'); ipcMain.handle('volumes', () => boot.volumes);
  }, { ...boot, volumes: [volume] });
  await page.reload();
  await computer();
  const card = page.locator('.drive-card').first();
  const image = card.locator('img.drive-icon');
  await image.waitFor(); await image.evaluate(el => el.decode());
  assert.ok(await image.evaluate(el => el.naturalWidth >= el.width * devicePixelRatio));
  assert.equal(await card.locator('strong').textContent(), 'Macintosh HD');
  assert.deepEqual(await card.locator('.drive-capacity > span').allTextContents(), ['99.6 GB 可用', '共 460.4 GB']);
  const used = await card.locator('.storage-track').evaluate(el => el.firstElementChild.getBoundingClientRect().width / el.getBoundingClientRect().width);
  assert.ok(Math.abs(used - (1 - 99.6 / 460.4)) < .005);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => window.explorer.setTheme(theme), theme);
    await page.waitForFunction(theme => matchMedia('(prefers-color-scheme: dark)').matches === (theme === 'dark'), theme);
    await page.mouse.move(1000, 700);
    await page.waitForFunction(theme => getComputedStyle(document.querySelector('.drive-card')).backgroundColor === (theme === 'dark' ? 'rgb(32, 32, 32)' : 'rgb(252, 252, 252)'), theme);
    await page.screenshot({ path: `artifacts/drive-card-${theme}.png` });
    const contrast = await card.evaluate(el => {
      const luminance = color => {
        const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; });
        return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
      };
      const background = luminance(getComputedStyle(el).backgroundColor);
      return [...el.querySelectorAll('strong, .drive-kind, .drive-capacity > span')].map(text => {
        const foreground = luminance(getComputedStyle(text).color);
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      });
    });
    assert.ok(contrast.every(value => value >= 4.5), `${theme} text contrast: ${contrast}`);
  }
  await card.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '打开', exact: true }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: /推出/ }).count(), 0);
  await page.getByRole('menuitem', { name: '打开', exact: true }).click();
  await page.locator('.file-content[aria-label="Macintosh HD"][aria-busy=false]').waitFor();
  await computer(); await card.dblclick();
  await page.locator('.file-content[aria-label="Macintosh HD"][aria-busy=false]').waitFor();
  await computer(); await card.focus(); await page.keyboard.press('Enter');
  await page.locator('.file-content[aria-label="Macintosh HD"][aria-busy=false]').waitFor();
  await computer(); await card.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await card.evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 600));
  assert.equal(await card.evaluate(el => { const r = el.getBoundingClientRect(); return r.right <= innerWidth && el.scrollWidth <= el.clientWidth; }), true);
  await page.screenshot({ path: 'artifacts/drive-card-compact.png' });

  const longName = '非常长的磁盘名称 '.repeat(12);
  await app.evaluate(({ ipcMain }, { boot, volume, longName, root }) => {
    const volumes = [volume, { ...volume, path: root, name: longName, canEject: true }];
    ipcMain.removeHandler('bootstrap'); ipcMain.handle('bootstrap', () => ({ ...boot, volumes }));
    ipcMain.removeHandler('volumes'); ipcMain.handle('volumes', () => volumes);
    ipcMain.removeHandler('icon'); ipcMain.handle('icon', () => { throw new Error('Fixture icon service failure'); });
  }, { boot, volume, longName, root });
  await page.reload(); await computer();
  await page.locator('.drive-card').nth(1).waitFor();
  assert.equal(await page.locator('svg.drive-icon').count(), 2);
  assert.equal(await page.locator('.drive-card').evaluateAll(cards => cards.every(el => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().right <= innerWidth)), true);
  await page.locator('.drive-card').nth(1).click({ button: 'right' });
  await page.getByRole('menuitem', { name: `推出“${longName}”`, exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.explorer.setLanguage('en'));
  await page.waitForFunction(() => document.querySelector('.drive-kind')?.textContent === 'Local disk');
  assert.equal(await card.locator('.drive-kind').textContent(), 'Local disk');
  await page.evaluate(() => window.explorer.setLanguage('zh-TW'));
  await page.waitForFunction(() => document.querySelector('.drive-kind')?.textContent === '本機磁碟');
  assert.equal(await card.locator('.drive-kind').textContent(), '本機磁碟');
  assert.deepEqual(errors, []);
  console.log('PASS: native Retina icon, capacities, light/dark contrast, context menu, double-click/Enter, focus, compact layout, multiple disks, long names, icon failure fallback and translations. Screenshots use fixture capacities.');
} finally {
  await app.close();
  await fs.rm(root, { recursive: true, force: true });
}
