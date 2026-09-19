import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {driver} from './qa-driver.mjs';
const d=await driver();const results=[];
const run=async(name,fn)=>{await fn();results.push(name);console.log('PASS',name);};
try {
  await d.evaluate(`(async()=>{const p=app.plugins.plugins['app-view'];p.settings.viewName='速查版';p.refreshName();const keep=app.workspace.getLeaf(false);for(const l of app.workspace.getLeavesOfType('markdown').concat(app.workspace.getLeavesOfType('app-view')))if(l!==keep)l.detach();await p.openSource('开始体验.md',undefined,keep);})()`);
  for(const options of [{modifiers:2},{button:'middle'}]) {
    await run(`${options.button??'Ctrl+left'} header click opens a new quick tab`,async()=>{
      const before=await d.evaluate("app.workspace.getLeavesOfType('markdown').length+app.workspace.getLeavesOfType('app-view').length");
      await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]',options);
      await d.wait("app.workspace.activeLeaf.view.getViewType()==='app-view'");
      assert.equal(await d.evaluate("app.workspace.getLeavesOfType('markdown').length+app.workspace.getLeavesOfType('app-view').length"),before+1);
      await d.click('.workspace-leaf.mod-active .view-action[aria-label*="返回详细版"]');
      await d.wait("app.workspace.activeLeaf.view.getViewType()==='markdown'");
    });
  }
  await run('custom name updates existing headers, commands and range badges immediately',async()=>{
    await d.evaluate("(async()=>{const p=app.plugins.plugins['app-view'];p.settings.viewName='精要版';await p.saveSettings();p.refreshName();})()");
    assert.ok((await d.evaluate("app.commands.commands['app-view:show-application'].name")).includes('查看精要版'));
    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看精要版"]');
    await d.wait("document.querySelector('.workspace-leaf.mod-active [aria-label=复制精要版纯文本]')!==null");
    await d.evaluate("(async()=>{const p=app.plugins.plugins['app-view'];p.settings.viewName='速查版';await p.saveSettings();p.refreshName();})()");
    assert.ok(await d.evaluate("!!document.querySelector('.workspace-leaf.mod-active [aria-label=复制速查版纯文本]')"));
  });
  await run('Ctrl+A/C copy selected projection without management labels',async()=>{
    const text=await d.evaluate(`(()=>{const v=app.workspace.activeLeaf.view;v.toggleManaging();v.contentEl.dispatchEvent(new KeyboardEvent('keydown',{key:'a',ctrlKey:true,bubbles:true,cancelable:true}));const data=new DataTransfer();v.contentEl.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));v.toggleManaging();window.getSelection().removeAllRanges();return data.getData('text/plain');})()`);
    assert.ok(text.includes('确认条件')&&!text.includes('移除本段')&&!text.includes('段落 1'));
  });
  await run('link hover emits native hover preview event',async()=>{
    assert.equal(await d.evaluate(`(()=>{let count=0;const ref=app.workspace.on('link-hover',()=>count++);const a=app.workspace.activeLeaf.view.contentEl.querySelector('a.internal-link');a.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));app.workspace.offref(ref);return count;})()`),1);
  });
  await run('external filesystem change refreshes an open projection',async()=>{
    const file='test-vault/_qa-external.md';const original='%%app%%\nBefore external edit\n%%/app%%\n';
    await d.evaluate(`(async()=>{let f=app.vault.getAbstractFileByPath('_qa-external.md');if(!f)f=await app.vault.create('_qa-external.md',${JSON.stringify(original)});else await app.vault.modify(f,${JSON.stringify(original)});await app.plugins.plugins['app-view'].openApplication(f);})()`);
    await fs.writeFile(file,original.replace('Before','After'));
    await d.wait("document.querySelector('.workspace-leaf.mod-active .app-view-body')?.textContent.includes('After external edit')");
  });
  await run('rename a note keeps its own preference and quick projection',async()=>{
    await d.evaluate("app.fileManager.renameFile(app.vault.getAbstractFileByPath('_qa-external.md'),'_qa-renamed.md')");
    await d.wait("app.workspace.activeLeaf.view.path==='_qa-renamed.md'");
    assert.equal(await d.evaluate("app.plugins.plugins['app-view'].settings.noteStates['_qa-renamed.md']"),'app');
    await d.evaluate("app.fileManager.trashFile(app.vault.getAbstractFileByPath('_qa-renamed.md'))");
  });
  await run('disabling plugin removes its header actions and leaves source unchanged',async()=>{
    const before=await fs.readFile('test-vault/开始体验.md','utf8');
    await d.evaluate("(async()=>{await app.plugins.plugins['app-view'].openSource('开始体验.md');await app.plugins.disablePlugin('app-view');})()");
    assert.equal(await d.evaluate("document.querySelectorAll('.app-view-toggle,.app-view-floating-bar').length"),0);
    await d.evaluate("(async()=>{await app.plugins.enablePluginAndSave('app-view');})()");
    await d.wait("!!app.plugins?.plugins?.['app-view']");
  });
} finally {await fs.writeFile('artifacts/qa-extra-results.json',JSON.stringify({results},null,2));d.close();}
