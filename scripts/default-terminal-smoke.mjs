import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'explorer-terminal-review-'));
await fs.mkdir(path.join(root, 'Documents'));
const target = path.join(root, 'folder with spaces and $quote'); await fs.mkdir(target);
const app = await electron.launch({ ...(process.env.EXPLORER_APP_PATH ? {executablePath:process.env.EXPLORER_APP_PATH,args:[]} : {args:[process.cwd()]}), env: { ...process.env, EXPLORER_TEST_ROOT: root, EXPLORER_TEST_HIDDEN: '1' } });
try {
 const page=await app.firstWindow(); await page.getByRole('tab').waitFor();
 await app.evaluate(() => {
  const cp=process.getBuiltinModule('child_process'), util=process.getBuiltinModule('util'); const original=cp.execFile;
  const run=util.promisify(original); globalThis.terminalCalls=[];
  const spy=()=>{};
  spy[util.promisify.custom]=async (command,args) => {
   if(command==='/usr/bin/open') {globalThis.terminalCalls.push({command,args});return {stdout:'',stderr:''};}
   if(command.endsWith('/default-terminal') && globalThis.failTerminal) {const error=new Error('helper failed');error.stderr='没有可用的终端应用。';throw error;}
   return run(command,args);
  };
  cp.execFile=spy;
 });
 await page.evaluate(target => window.explorer.openTerminal(target),target);
 const calls=await app.evaluate(()=>globalThis.terminalCalls);
 assert.equal(calls.length,1);assert.equal(calls[0].args[0],'-a');assert.ok(calls[0].args[1].endsWith('.app'));assert.equal(calls[0].args[2],target);
 await app.evaluate(()=>{globalThis.failTerminal=true;});
 await assert.rejects(page.evaluate(target=>window.explorer.openTerminal(target),target),/没有可用的终端应用/);
 console.log('PASS: native default-terminal lookup returned '+calls[0].args[1]+'; literal directory arguments and helper failure checked. Launch was stubbed; no terminal or system default changed.');
} finally {await app.close();await fs.rm(root,{recursive:true,force:true});}
