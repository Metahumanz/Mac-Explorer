import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-icons-'));
const docs = path.join(root, 'Documents');
await fs.mkdir(docs);
const systemFolders = { Applications: 'applications', Desktop: 'desktop', Documents: 'document', Downloads: 'download', Pictures: 'image', Music: 'music', Movies: 'video' };
for (const name of Object.keys(systemFolders)) {
  if (name !== 'Documents') await fs.mkdir(path.join(root, name));
  await fs.mkdir(path.join(docs, name));
}
await fs.mkdir(path.join(docs, '项目资料'));
for (const name of ['项目说明.docx', '设计说明.pdf', '配置.json', '使用说明.txt', '设置.INI']) await fs.writeFile(path.join(docs, name), 'Temporary icon test fixture');
await fs.mkdir('artifacts', { recursive: true });
const app = await electron.launch({ colorScheme: null, ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_ROOT: root } });
const page = await app.firstWindow();
const errors = []; page.on('pageerror', error => errors.push(error.message));
const result = { executable: process.env.EXPLORER_APP_PATH || 'source build', pixelChecks: [], passed: false };
try {
  await page.getByRole('option', { name: '项目说明.docx', exact: true }).waitFor();
  const ini = page.getByRole('option', { name: '设置.INI', exact: true }).locator('img.file-glyph');
  await ini.evaluate(el => el.decode());
  assert.equal(await ini.evaluate(el => el.naturalWidth), 256);
  assert.match(await ini.getAttribute('src'), /\/ini-[^/]+\.png$/);
  assert.equal(await page.getByRole('option', { name: '配置.json', exact: true }).locator('img.file-glyph').getAttribute('src').then(src => /\/ini-[^/]+\.png$/.test(src || '')), false);
  assert.equal(await page.locator('.file-row .folder-badge').count(), 0, 'Nested namesakes remain ordinary folders');
  // Clicking the final breadcrumb once edits the existing location; it must not
  // push the same location into history or reset the input on subsequent clicks.
  await page.locator('.breadcrumbs button').last().click();
  const address = page.getByRole('textbox', { name: '文件夹地址', exact: true });
  await address.waitFor();
  assert.equal(await address.inputValue(), docs);
  assert.equal(await address.evaluate(el => document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === el.value.length), true);
  await address.fill(path.join(docs, '项目资料'));
  await address.click();
  assert.equal(await address.inputValue(), path.join(docs, '项目资料'));
  await address.press('Enter');
  await page.getByText('此文件夹为空', { exact: true }).waitFor();
  await page.locator('.breadcrumbs button').filter({ hasText: /^文档$/ }).click();
  await page.getByRole('option', { name: '项目说明.docx', exact: true }).waitFor();
  assert.equal(await address.count(), 0);
  const bounds = await page.locator('.address-bar').boundingBox();
  await page.mouse.click(bounds.x + bounds.width - 42, bounds.y + bounds.height / 2);
  await address.waitFor();
  assert.equal(await address.inputValue(), docs);
  await address.press('Escape');
  console.log('PASS: single-click current breadcrumb/blank area edits path; typing, Enter, Escape and ancestor navigation work');

  for (const [label, size] of [['小图标', 32], ['中图标', 48], ['大图标', 64], ['超大图标', 128]]) {
    await page.getByRole('button', { name: '查看', exact: true }).click();
    await page.getByRole('menuitemradio', { name: label, exact: true }).click();
    const icon = page.getByRole('option', { name: '项目说明.docx', exact: true }).locator('img.file-glyph');
    await icon.waitFor();
    await page.waitForFunction(size => {
      const icon = document.querySelector('.icon-grid img.file-glyph');
      return icon && icon.getBoundingClientRect().width === size && icon.naturalWidth >= size * window.devicePixelRatio;
    }, size);
    const measurement = await icon.evaluate(el => ({ rendered: el.getBoundingClientRect().width, pixels: el.naturalWidth, dpr: window.devicePixelRatio }));
    result.pixelChecks.push(measurement);
    assert.equal(Number(await page.getByRole('slider', { name: '图标大小' }).inputValue()), size);
    if (size === 64 || size === 128) await page.screenshot({ path: `artifacts/icons-${size}-sharp.png` });
  }
  console.log('PASS: all four icon presets use sufficient physical pixels at Retina scale');
  const slider = page.getByRole('slider', { name: '图标大小' });
  await slider.focus(); await slider.press('Home'); await slider.press('ArrowRight');
  assert.equal(await slider.inputValue(), '40');
  await page.reload();
  await page.getByRole('option', { name: '项目说明.docx', exact: true }).waitFor();
  assert.equal(await page.getByRole('slider', { name: '图标大小' }).inputValue(), '40');
  const pane = await page.locator('.file-content').boundingBox();
  await page.mouse.move(pane.x + 40, pane.y + 220);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control');
  await page.waitForFunction(() => document.querySelector('input[type=range]')?.value === '48');
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1);
  console.log('PASS: slider, persisted size and Ctrl+wheel adjust icons without zooming the application');

  const pngs = await page.evaluate(async filePath => {
    const values = await Promise.all([64, 256, 512].map(pixels => window.explorer.icon(filePath, pixels)));
    return values;
  }, path.join(docs, '项目说明.docx'));
  for (const [index, size] of [64, 256, 512].entries()) {
    const png = Buffer.from(pngs[index].split(',')[1], 'base64');
    assert.equal(png.readUInt32BE(16), size); assert.equal(png.readUInt32BE(20), size);
    await fs.writeFile(`artifacts/native-icon-${size}.png`, png);
  }
  console.log('PASS: native icon service returns independent 64 / 256 / 512 pixel PNGs');
  await page.getByRole('navigation', { name: '文件位置' }).getByRole('button', { name: '个人文件夹', exact: true }).click();
  await page.getByRole('option', { name: 'Music', exact: true }).waitFor();
  for (const [name, icon] of Object.entries(systemFolders)) {
    assert.equal(await page.getByRole('option', { name, exact: true }).locator(`.folder-badge .icon-${icon}`).count(), 1);
    assert.equal(await page.locator(`.sidebar .icon-${icon}`).count(), 1);
  }
  for (const mode of ['小图标', '大图标', '超大图标', '详细信息', '平铺', '内容']) {
    await page.getByRole('button', { name: '查看', exact: true }).click();
    await page.getByRole('menuitemradio', { name: mode, exact: true }).click();
    const badge = page.getByRole('option', { name: 'Music', exact: true }).locator('.folder-badge');
    assert.equal(await badge.count(), 1);
    assert.ok(await badge.evaluate(el => el.getBoundingClientRect().width <= el.parentElement.getBoundingClientRect().width));
  }
  await page.getByRole('button', { name: '大图标视图', exact: true }).click();
  await page.getByRole('option', { name: 'Music', exact: true }).click();
  await page.getByRole('button', { name: '查看', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: '详细信息窗格', exact: true }).click();
  await page.locator('.preview-hero .badge-music').waitFor();
  await page.getByRole('button', { name: '关闭详细信息', exact: true }).click();
  await page.getByRole('button', { name: '预览窗格', exact: true }).click();
  await page.locator('.preview-pane .badge-music').waitFor();
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.getByRole('option', { name: 'Music', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: '从快速访问取消固定', exact: true }).click();
  assert.equal(await page.locator('.sidebar .icon-music').count(), 0);
  assert.equal(await page.getByRole('option', { name: 'Music', exact: true }).locator('.badge-music').count(), 1);
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => window.explorer.setTheme(theme), theme);
    await page.waitForFunction(dark => matchMedia('(prefers-color-scheme: dark)').matches === dark, theme === 'dark');
    await page.mouse.move(900, 175);
    await page.screenshot({ path: `artifacts/system-folders-${theme}.png`, animations: 'disabled' });
  }
  await page.getByRole('option', { name: 'Downloads', exact: true }).dblclick();
  await page.locator('.file-content[aria-busy="false"]').waitFor();
  assert.equal(await page.getByRole('tab', { selected: true }).locator('.badge-download').count(), 1);
  assert.equal(await page.locator('.address-icon .icon-download').count(), 1);
  console.log('PASS: actual system-folder paths share sidebar symbols across layouts, tabs, address and panes; nested namesakes and unpinned defaults stay correct');

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(820, 600));
  await page.screenshot({ path: 'artifacts/icon-controls-compact.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  result.passed = true;
  await fs.writeFile(`artifacts/${process.env.EXPLORER_APP_PATH ? 'packaged-' : ''}icon-address-result.json`, JSON.stringify(result, null, 2));
} catch (error) {
  await page.screenshot({ path: 'artifacts/icon-address-failure.png' });
  throw error;
} finally { await app.close(); await fs.rm(root, { recursive: true, force: true }); }
