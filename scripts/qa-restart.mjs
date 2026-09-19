import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {driver} from './qa-driver.mjs';

let d = await driver();
const results=[];
try {
  await d.evaluate(`(async()=>{
    const p=app.plugins.plugins['app-view'];
    const keep=app.workspace.getLeaf(false);
    for(const l of app.workspace.getLeavesOfType('markdown').concat(app.workspace.getLeavesOfType('app-view'))) if(l!==keep)l.detach();
    await keep.openFile(app.vault.getAbstractFileByPath('_qa-A.md'),{active:true});
    await p.openApplication(app.vault.getAbstractFileByPath('_qa-A.md'),undefined,keep);
    const detail=app.workspace.getLeaf('split');
    await p.openSource('_qa-A.md',undefined,detail);
    await detail.setViewState({type:'markdown',state:{file:'_qa-A.md',mode:'source',source:true}});
    const b=app.workspace.getLeaf('tab');
    await b.openFile(app.vault.getAbstractFileByPath('_qa-B.md'),{active:true});
    await b.setViewState({type:'markdown',state:{file:'_qa-B.md',mode:'preview',source:false},active:true});
    await p.openApplication(app.vault.getAbstractFileByPath('_qa-A.md'),undefined,keep);
    await p.saveSettings();
    await app.workspace.saveLayout();
  })()`);
  const before=JSON.parse(await fs.readFile('test-vault/.obsidian/plugins/app-view/data.json','utf8'));
  assert.equal(before.noteStates['_qa-A.md'],'app');
  await d.evaluate('setTimeout(()=>require("electron").remote.app.quit(),150);true');
  d.close();
  let closed=false;
  for(let i=0;i<100;i++) {
    await new Promise(r=>setTimeout(r,100));
    try {await fetch('http://127.0.0.1:9237/json/list',{signal:AbortSignal.timeout(500)});} catch {closed=true;break;}
  }
  assert.ok(closed,'isolated Obsidian must actually exit');
  results.push('isolated Obsidian process exited normally');
  const child=spawn(process.env.OBSIDIAN_EXE??'D:\\Obsidian\\Obsidian.exe',[
    `--user-data-dir=${path.resolve('artifacts/profile')}`,'--remote-debugging-port=9237'
  ],{detached:true,stdio:'ignore',windowsHide:true});
  child.unref();
  let opened=false;
  for(let i=0;i<120;i++) {
    await new Promise(r=>setTimeout(r,200));
    try {const pages=await(await fetch('http://127.0.0.1:9237/json/list')).json();if(pages.some(p=>p.title.includes('test-vault'))){opened=true;break;}} catch {}
  }
  assert.ok(opened,'isolated vault must reopen');
  d=await driver();
  await d.wait("!!app.plugins.plugins['app-view'] && app.workspace.layoutReady");
  await d.wait("app.workspace.getLeavesOfType('app-view').some(l=>l.view.file?.path==='_qa-A.md')");
  // Deferred/background leaves are loaded on demand, as in actual tab activation.
  await d.evaluate("(async()=>{const leaves=[];app.workspace.iterateAllLeaves(l=>{if(['markdown','app-view'].includes(l.getViewState().type))leaves.push(l);});for(const l of leaves)await l.loadIfDeferred();})()");
  await d.wait("app.workspace.getLeavesOfType('markdown').some(l=>l.view.file?.path==='_qa-A.md' && l.view.getState().source===true)");
  assert.equal(await d.evaluate("app.plugins.plugins['app-view'].settings.noteStates['_qa-A.md']"),'app');
  results.push('cold restart preserved simultaneous quick A and source-detail A');
  const after=await d.evaluate("app.plugins.plugins['app-view'].settings");
  assert.deepEqual(after.noteStates,before.noteStates);
  assert.deepEqual(after.markdownStates,before.markdownStates);
  results.push('preferences survived actual process restart without layout overwrites');
  await d.evaluate("(async()=>{const l=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='_qa-B.md');await app.workspace.revealLeaf(l);app.workspace.setActiveLeaf(l);})()");
  await d.nav('_qa-A.md','app-view');
  await d.nav('_qa-B.md','markdown');
  assert.equal(await d.evaluate('app.workspace.activeLeaf.view.getMode()'),'preview');
  results.push('after restart left-click A restores quick and B restores reading detail');
  console.log(results.map(r=>'PASS '+r).join('\n'));
} finally {
  d.close();
  await fs.writeFile('artifacts/qa-restart-results.json',JSON.stringify({results},null,2));
}
