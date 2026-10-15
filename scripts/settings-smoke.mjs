import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'explorer-settings-'));
await fs.mkdir(path.join(root,'Documents'));
let app,page;
const chosen='Command+Alt+K';
async function launch(conflict='') {
 app=await electron.launch({colorScheme:null,...(process.env.EXPLORER_APP_PATH?{executablePath:process.env.EXPLORER_APP_PATH,args:[]}:{args:['-r',path.resolve('scripts/fixtures/shortcut-capture.cjs'),process.cwd()]}),env:{...process.env,EXPLORER_TEST_ROOT:root,EXPLORER_TEST_HIDDEN:'1',EXPLORER_SHORTCUT_TEST_CONFLICT:conflict}});
 page=await app.firstWindow();page.setDefaultTimeout(10000);await page.getByRole('tab').waitFor();
 await app.evaluate(({globalShortcut})=>{
  const register=globalShortcut.register.bind(globalShortcut);globalThis.wakeCallbacks={};globalThis.shortcutConflict='';
  globalShortcut.register=(key,callback)=>{const ok=key!==globalThis.shortcutConflict&&register(key,callback);if(ok)globalThis.wakeCallbacks[key]=callback;return ok;};
 });
}
async function openSettings() {
 await page.getByRole('button',{name:'更多',exact:true}).click();
 await page.getByRole('menuitem',{name:'设置…',exact:true}).click();
 await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
 await page.waitForFunction(()=>!document.querySelector('input[aria-label="唤醒快捷键"]').disabled);
}
const state=()=>page.evaluate(()=>window.explorer.settings());
const registered=value=>app.evaluate(({globalShortcut},value)=>globalShortcut.isRegistered(value),value);
try {
 await launch();
 assert.equal((await state()).wakeShortcut,'');assert.equal(await registered('Command+E'),false);
 assert.equal(await page.evaluate(()=>typeof window.explorer.setDefaultApp),'undefined');
 await openSettings();
 assert.equal(await page.getByText('接管桌面（隐藏访达桌面图标）',{exact:true}).count(),0);
 await page.getByRole('textbox',{name:'唤醒快捷键',exact:true}).focus();
 await page.evaluate(()=>window.explorer.captureShortcut(true));
 await page.getByRole('textbox',{name:'唤醒快捷键',exact:true}).press('Meta+x');
 assert.equal(await page.getByRole('textbox',{name:'唤醒快捷键',exact:true}).inputValue(),'⌘+X');
 await page.getByRole('textbox',{name:'唤醒快捷键',exact:true}).press('Meta+Alt+k');
 await page.getByRole('button',{name:'保存快捷键',exact:true}).click();
 await page.waitForFunction(()=>window.explorer.settings().then(s=>s.wakeShortcut==='Command+Alt+K'));
 assert.equal(await registered(chosen),true);
 assert.equal(JSON.parse(await fs.readFile(path.join(root,'.app-data/shortcuts.json'),'utf8')).wakeShortcut,chosen);
 for(const key of [',','.','-']) {
  await page.getByRole('textbox',{name:'唤醒快捷键',exact:true}).press('Meta+Alt+'+key);
  await page.getByRole('button',{name:'保存快捷键',exact:true}).click();
  await page.waitForFunction(key=>window.explorer.settings().then(s=>s.wakeShortcut==='Command+Alt+'+key),key);
  assert.equal(await registered('Command+Alt+'+key),true);
 }
 await page.getByRole('textbox',{name:'唤醒快捷键',exact:true}).press('Meta+Alt+k');
 await page.getByRole('button',{name:'保存快捷键',exact:true}).click();
 await page.waitForFunction(()=>window.explorer.settings().then(s=>s.wakeShortcut==='Command+Alt+K'));
 await page.getByRole('textbox',{name:'唤醒快捷键',exact:true}).press('Meta+Alt+u');
 await app.evaluate(()=>{globalThis.shortcutConflict='Command+Alt+U';});
 await page.getByRole('button',{name:'保存快捷键',exact:true}).click();

 await page.getByRole('alert').waitFor();assert.equal((await state()).wakeShortcut,chosen);assert.equal(await registered(chosen),true);
 await app.evaluate(()=>{globalThis.shortcutConflict='';});
 await assert.rejects(page.evaluate(()=>window.explorer.setWakeShortcut('E')),/修饰键/);
 await assert.rejects(page.evaluate(()=>window.explorer.setWakeShortcut('Command+Command+K')),/修饰键/);
 await app.evaluate(()=>{const fs=process.getBuiltinModule('fs/promises');globalThis.savedRename=fs.rename;fs.rename=async()=>{throw new Error('fixture write failed');};});
 await assert.rejects(page.evaluate(()=>window.explorer.setWakeShortcut('Command+Alt+J')),/fixture write failed/);
 await app.evaluate(()=>{process.getBuiltinModule('fs/promises').rename=globalThis.savedRename;});
 assert.equal((await state()).wakeShortcut,chosen);assert.equal(await registered(chosen),true);assert.equal(await registered('Command+Alt+J'),false);
 // Login operations are stubbed inside this process; no login service is registered.
 await app.evaluate(()=>{
  const path=process.getBuiltinModule('path'), require=process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json');
  const native=require(process.env.EXPLORER_APP_PATH?path.join(process.env.EXPLORER_APP_PATH,'../../Resources/app.asar.unpacked/dist-electron/native/defaults.node'):process.cwd()+'/dist-electron/native/defaults.node');
  let login=false;native.appURL=()=>path.join(process.getBuiltinModule('os').homedir(),'Applications/Mac Explorer.app');native.bundleID=()=>'local.macexplorer.desktop';native.loginEnabled=()=>login;native.setLogin=value=>{login=value;return true;};
 });
 assert.equal((await state()).loginAvailable,true);
 assert.equal((await page.evaluate(()=>window.explorer.setLoginEnabled(true))).login,true);
 assert.equal((await page.evaluate(()=>window.explorer.setLoginEnabled(false))).login,false);
 await page.getByRole('button',{name:'关闭设置',exact:true}).click();await openSettings();
 await page.getByRole('checkbox',{name:'登录时自动启动',exact:true}).click();
 await page.waitForFunction(()=>window.explorer.settings().then(s=>s.login));
 await page.getByRole('checkbox',{name:'登录时自动启动',exact:true}).click();
 await page.waitForFunction(()=>window.explorer.settings().then(s=>!s.login));
 await page.getByRole('button',{name:'关闭设置',exact:true}).click();
 await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].minimize();globalThis.wakeCallbacks['Command+Alt+K']();});
 assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMinimized()),false);
 const opened=app.waitForEvent('window');
 await app.evaluate(({app,BrowserWindow})=>{app.removeAllListeners('window-all-closed');app.on('window-all-closed',()=>{});for(const win of BrowserWindow.getAllWindows())win.destroy();globalThis.wakeCallbacks['Command+Alt+K']();});
 page=await opened;await page.getByRole('tab').waitFor();assert.equal(app.windows().length,1);
 const settingsWindow=app.waitForEvent('window');
 await app.evaluate(({BrowserWindow,Menu})=>{
  for(const window of BrowserWindow.getAllWindows())window.destroy();
  Menu.getApplicationMenu().items.flatMap(item=>item.submenu?.items||[]).find(item=>item.accelerator==='Command+,').click();
 });
 page=await settingsWindow;await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
 await app.evaluate(({app})=>{app.removeAllListeners('window-all-closed');app.on('window-all-closed',()=>app.quit());});
 await app.close();await launch();assert.equal((await state()).wakeShortcut,chosen);assert.equal(await registered(chosen),true);
 await app.close();await launch(process.env.EXPLORER_APP_PATH?'':chosen);await openSettings();
 if(!process.env.EXPLORER_APP_PATH) {await page.getByRole('alert').waitFor();assert.equal(await registered(chosen),false);}
 else assert.equal(await registered(chosen),true);
 await page.getByRole('button',{name:'清除',exact:true}).click();await page.getByRole('button',{name:'保存快捷键',exact:true}).click();
 await page.waitForFunction(()=>window.explorer.settings().then(s=>s.wakeShortcut===''));
 await app.close();await launch();assert.equal((await state()).wakeShortcut,'');assert.equal(await registered(chosen),false);assert.equal(await registered('Command+E'),false);
 await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.flatMap(item=>item.submenu?.items||[]).find(item=>item.accelerator==='Command+,').click());
 await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
 await page.waitForFunction(()=>Promise.all(document.querySelector('dialog').getAnimations().map(animation=>animation.finished)).then(()=>true));
 assert.equal(await page.locator('dialog').evaluate(element=>element.scrollWidth<=element.clientWidth),true);
 await page.screenshot({path:path.resolve('../settings-fixture.png')});
 await page.evaluate(()=>window.explorer.setTheme('dark'));
 await page.waitForFunction(()=>getComputedStyle(document.body).backgroundColor==='rgb(25, 25, 25)');
 await page.screenshot({path:path.resolve('../settings-dark-fixture.png')});
 await page.getByRole('button',{name:'关闭设置',exact:true}).click();
 await page.evaluate(()=>window.explorer.setLanguage('en'));
 await app.evaluate(({Menu})=>Menu.getApplicationMenu().items.flatMap(item=>item.submenu?.items||[]).find(item=>item.accelerator==='Command+,').click());
 await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();
 await page.waitForFunction(()=>Promise.all(document.querySelector('dialog').getAnimations().map(animation=>animation.finished)).then(()=>true));
 assert.equal(await page.locator('dialog').evaluate(element=>element.scrollWidth<=element.clientWidth),true);
 await page.screenshot({path:path.resolve('../settings-english-fixture.png')});
 console.log('Startup conflict injection:',process.env.EXPLORER_APP_PATH?'source-only; packaged startup registration verified':'passed');
 console.log('PASS: settings page and native entry; no default Command+E; custom shortcut capture/save/clear/restart, conflict preservation, wake restore/new-window callback, login toggle with native service stubbed.');
} finally {await app?.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true,maxRetries:3});}
