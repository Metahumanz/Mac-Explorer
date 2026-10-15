import { _electron as electron } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const outcomes=[];
for(let attempt=0;attempt<3;attempt++) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'explorer-quickquit-'));await fs.mkdir(path.join(root,'Documents'));
 const app=await electron.launch({...(process.env.EXPLORER_APP_PATH ? {executablePath:process.env.EXPLORER_APP_PATH,args:[]} : {args:[process.cwd()]}),env:{...process.env,EXPLORER_TEST_ROOT:root,EXPLORER_TEST_HIDDEN:'1'}});
 try {
  const page=await app.firstWindow();await page.getByRole('tab').waitFor();
  const preference=path.join(root,'.app-data','window-state.json');
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setBounds({x:130,y:110,width:900,height:600});});
  // Wait for the baseline write, then move and quit before the 400ms debounce.
  for(let i=0;i<50;i++){try{JSON.parse(await fs.readFile(preference,'utf8'));break;}catch{await new Promise(r=>setTimeout(r,50));}}
  const closed=app.waitForEvent('close');
  await app.evaluate(({BrowserWindow,app})=>{const win=BrowserWindow.getAllWindows()[0];win.setBounds({x:210,y:150,width:1050,height:650});app.quit();}).catch(()=>{});
  await closed;
  const saved=await fs.readFile(preference,'utf8').catch(()=>null);outcomes.push({attempt,saved:saved?JSON.parse(saved):null,expectedWidth:1050,expectedHeight:650});
 } finally {await app.close().catch(()=>{});await fs.rm(root,{recursive:true,force:true});}
}
console.log(JSON.stringify(outcomes,null,2));
if(outcomes.some(o=>o.saved?.width!==o.expectedWidth||o.saved?.height!==o.expectedHeight)) {console.error('FAIL: final bounds were not saved when quitting immediately.');process.exitCode=1;}
else console.log('PASS: quick quit preserved final bounds.');
