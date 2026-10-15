import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-settings-window-'));
await fs.mkdir(path.join(root, 'Documents'));
await fs.mkdir('artifacts/settings', { recursive: true });
let app;
try {
 app = await electron.launch({ colorScheme: null, ...(process.env.EXPLORER_APP_PATH ? { executablePath: process.env.EXPLORER_APP_PATH, args: [] } : { args: [process.cwd()] }), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_LOCALE: 'zh-CN', EXPLORER_TEST_HIDDEN: '1' } });
 const page = await app.firstWindow(); page.setDefaultTimeout(10000);
 const errors = []; page.on('pageerror', error => errors.push(error.message));
 await page.getByRole('tab').waitFor();
 await app.evaluate(({Menu}) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).find(item => item.accelerator === 'Command+,').click());
 await page.getByRole('dialog', {name: '设置', exact: true}).waitFor();
 await page.waitForFunction(() => Promise.all(document.querySelector('dialog').getAnimations().map(animation => animation.finished)).then(() => true));
 const owner=await app.browserWindow(page);
 const bounds=()=>page.locator('dialog').evaluate(element=>{const r=element.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height};});
 const contained=()=>page.locator('dialog').evaluate(element=>{const r=element.getBoundingClientRect();return r.left>=11&&r.top>=11&&r.right<=innerWidth-11&&r.bottom<=innerHeight-11;});
 await owner.evaluate(window=>window.setSize(1100,900));
 await page.waitForFunction(()=>Math.abs(document.querySelector('dialog').getBoundingClientRect().height-700)<1);
 assert.equal(Math.round((await bounds()).width),560);
 await page.screenshot({path:path.resolve('artifacts/settings/taller-fixture.png')});
 const handle=page.getByRole('group',{name:'拖动或使用方向键移动设置窗口',exact:true});
 async function dragBy(dx,dy) {
  const box=await handle.boundingBox();
  await page.mouse.move(box.x+100,box.y+20);await page.mouse.down();
  await page.mouse.move(box.x+100+dx,box.y+20+dy,{steps:8});await page.mouse.up();
 }
 const initial=await bounds();await dragBy(90,35);let moved=await bounds();
 assert.ok(Math.abs(moved.left-initial.left-90)<2);assert.ok(Math.abs(moved.top-initial.top-35)<2);
 await page.screenshot({path:path.resolve('artifacts/settings/moved-fixture.png')});
 await handle.focus();await handle.press('ArrowLeft');
 assert.ok(Math.abs((await bounds()).left-moved.left+10)<2);
 // Capture keeps dragging outside the title bar, and all four edges stay reachable.
 await dragBy(-3000,-3000);assert.ok(await contained());
 assert.ok((await bounds()).left<=13);assert.ok((await bounds()).top<=13);
 await dragBy(3000,3000);assert.ok(await contained());
 const released=await bounds();await page.mouse.move(100,100);assert.deepEqual(await bounds(),released);
 // Cancellation must end the drag without leaving the title bar attached to the pointer.
 const box=await handle.boundingBox();await page.mouse.move(box.x+100,box.y+20);await page.mouse.down();
 await handle.evaluate(element=>element.dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));
 const cancelled=await bounds();await page.mouse.move(300,100);await page.mouse.up();assert.deepEqual(await bounds(),cancelled);
 await owner.evaluate(window=>window.setSize(800,650));
 await page.waitForFunction(()=>innerWidth<=800);
 await page.waitForFunction(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return r.left>=11&&r.top>=11&&r.right<=innerWidth-11&&r.bottom<=innerHeight-11;});
 assert.ok((await bounds()).height>480);assert.ok(await contained());
 await page.getByRole('button',{name:'关闭设置',exact:true}).click();
 await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.flatMap(item=>item.submenu?.items||[]).find(item=>item.accelerator==='Command+,').click());
 await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
 await page.waitForFunction(()=>Promise.all(document.querySelector('dialog').getAnimations().map(animation=>animation.finished)).then(()=>true));
 assert.equal(await page.locator('dialog').evaluate(element=>!element.style.left),true);
 assert.ok(await contained());
 for (const label of ['常规', '自定义工具栏', '键盘快捷键']) {
  await page.getByRole('tab', {name: label, exact: true}).click();
  assert.ok(await contained());
  assert.equal(await page.getByRole('tabpanel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
 }
 await page.getByRole('tab', {name: '常规', exact: true}).click();
 await page.getByRole('radio', {name: '深色', exact: true}).click();
 await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(25, 25, 25)');
 await page.waitForFunction(() => !document.querySelector('.theme-options input').disabled);
 await page.screenshot({path: path.resolve('artifacts/settings/taller-dark-fixture.png')});
 await page.getByRole('button', {name: '关闭设置', exact: true}).click();
 await page.evaluate(() => window.explorer.setLanguage('en'));
 await app.evaluate(({Menu}) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).find(item => item.accelerator === 'Command+,').click());
 await page.getByRole('dialog', {name: 'Settings', exact: true}).waitFor();
 await page.waitForFunction(() => Promise.all(document.querySelector('dialog').getAnimations().map(animation => animation.finished)).then(() => true));
 for (const label of ['General', 'Customize toolbar', 'Keyboard shortcuts']) {
  await page.getByRole('tab', {name: label, exact: true}).click(); assert.ok(await contained());
  assert.equal(await page.getByRole('tabpanel').evaluate(element => element.scrollWidth <= element.clientWidth), true);
 }
 await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state: 'hidden'});
 assert.deepEqual(errors, []);
 console.log('PASS: 700px height, mouse and keyboard movement, four-edge clamping, release/cancellation, viewport shrink, close/reopen centering, scrolling tabs, dark mode, English, and Escape. Fixture screenshots saved.');
} finally {
 await app?.close().catch(() => {});
 await fs.rm(root, {recursive: true, force: true});
}
