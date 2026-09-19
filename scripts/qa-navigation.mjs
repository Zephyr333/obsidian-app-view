import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { driver } from './qa-driver.mjs';
const d = await driver();
const results = [];
const run = async (name, fn) => {await fn(); results.push(name); console.log('PASS', name);};
try {
  await d.evaluate(`(async () => {
    const p = app.plugins.plugins['app-view'];
    for (const name of ['_qa-A.md','_qa-B.md']) {
      const content = '# '+name+'\\n\\n%%app%%\\n- [ ] Task '+name+'\\n%%/app%%\\n';
      const file = app.vault.getAbstractFileByPath(name);
      if (file) await app.vault.modify(file, content);
      else if (await app.vault.adapter.exists(name)) await app.vault.adapter.write(name, content);
      else await app.vault.create(name, content);
      delete p.settings.noteStates[name]; delete p.settings.markdownStates[name];
    }
    await p.saveSettings();
    const keep = app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf(false);
    app.workspace.setActiveLeaf(keep, { focus: true });
    for (const l of app.workspace.getLeavesOfType('markdown').concat(app.workspace.getLeavesOfType('app-view'))) {
      if (l !== keep) l.detach();
    }
    await keep.setViewState({ type: 'empty', active: true });
    app.workspace.leftSplit.expand();
  })()`);
  await new Promise(r => setTimeout(r, 600));
  await d.nav('_qa-A.md', 'markdown');
  await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]');
  await d.wait('app.workspace.activeLeaf.view.getViewType()==="app-view"');
  await run('unseen B opens detail after quick A', () => d.nav('_qa-B.md', 'markdown'));
  await run('left click A restores its own quick view', () => d.nav('_qa-A.md', 'app-view'));
  await run('repeated A/B navigation stays independent', async () => {
    for(let i=0;i<8;i++) {await d.nav('_qa-B.md','markdown'); await d.nav('_qa-A.md','app-view');}
  });
  await run('explicit return remembers detail', async () => {
    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="返回详细版"]');
    await d.wait('app.workspace.activeLeaf.view.getViewType()==="markdown"');
    await d.nav('_qa-B.md','markdown'); await d.nav('_qa-A.md','markdown');
  });
  await run('disk has independent note preferences', async () => {
    const data=JSON.parse(await fs.readFile('test-vault/.obsidian/plugins/app-view/data.json','utf8'));
    assert.equal(data.noteStates['_qa-A.md'],'detail');
    assert.notEqual(data.noteStates['_qa-B.md'],'app');
  });
  await run('reading/live-preview/source detailed modes restore independently', async () => {
    for (const state of [{mode:'preview',source:false},{mode:'source',source:true},{mode:'source',source:false}]) {
      await d.evaluate(`app.workspace.activeLeaf.setViewState({type:'markdown',state:{file:'_qa-A.md',...${JSON.stringify(state)}}})`);
      await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]');
      await d.wait('app.workspace.activeLeaf.view.getViewType()==="app-view"');
      await d.nav('_qa-B.md','markdown'); await d.nav('_qa-A.md','app-view');
      await d.click('.workspace-leaf.mod-active .view-action[aria-label*="返回详细版"]');
      await d.wait(`app.workspace.activeLeaf.view.getViewType()==='markdown' && app.workspace.activeLeaf.view.getState().mode===${JSON.stringify(state.mode)} && app.workspace.activeLeaf.view.getState().source===${state.source}`);
    }
  });
  await run('concurrent requests settle on last navigation without state contagion', async () => {
    await d.evaluate(`(async()=>{const p=app.plugins.plugins['app-view'];await p.openApplication(app.vault.getAbstractFileByPath('_qa-A.md'));const l=app.workspace.activeLeaf;await Promise.all(['_qa-B.md','_qa-A.md','_qa-B.md','_qa-A.md'].map(path=>l.openFile(app.vault.getAbstractFileByPath(path),{active:true})));})()`);
    await d.wait("app.workspace.activeLeaf.view.getViewType()==='app-view' && app.workspace.activeLeaf.view.file.path==='_qa-A.md'");
    assert.notEqual(await d.evaluate("app.plugins.plugins['app-view'].settings.noteStates['_qa-B.md']"),'app');
  });
  await run('split detail/quick views survive focus changes and reopen preference is independent', async () => {
    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="返回详细版"]', {modifiers:6});
    await d.wait("app.workspace.getLeavesOfType('markdown').some(l=>l.view.file?.path==='_qa-A.md') && app.workspace.getLeavesOfType('app-view').some(l=>l.view.file?.path==='_qa-A.md')");
    await d.evaluate(`(()=>{const a=app.workspace.getLeavesOfType('app-view').find(l=>l.view.file.path==='_qa-A.md');const b=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file.path==='_qa-A.md'); window.__qaSplit={a:a.id,b:b.id};for(let i=0;i<5;i++){app.workspace.setActiveLeaf(a);app.workspace.setActiveLeaf(b);}})()`);
    assert.equal(await d.evaluate("app.workspace.getLeavesOfType('app-view').filter(l=>l.view.file.path==='_qa-A.md').length"),1);
    assert.equal(await d.evaluate("app.plugins.plugins['app-view'].settings.noteStates['_qa-A.md']"),'detail');
    await d.nav('_qa-B.md','markdown'); await d.nav('_qa-A.md','markdown');
    assert.equal(await d.evaluate("app.workspace.getLeavesOfType('app-view').filter(l=>l.view.file.path==='_qa-A.md').length"),1);
  });
  await run('navigation history restores the concrete view of that leaf', async () => {
    await d.nav('_qa-B.md','markdown');
    await d.evaluate("app.commands.executeCommandById('app:go-back')");
    await d.wait("app.workspace.activeLeaf.view.file?.path==='_qa-A.md' && app.workspace.activeLeaf.view.getViewType()==='markdown'");
    await d.evaluate("app.commands.executeCommandById('app:go-forward')");
    await d.wait("app.workspace.activeLeaf.view.file?.path==='_qa-B.md'");
  });
  await run('plugin reload preserves preferences and reinstalls one navigation wrapper', async () => {
    await d.evaluate("(async()=>{await app.plugins.disablePlugin('app-view');await app.plugins.enablePlugin('app-view');})()");
    await d.nav('_qa-A.md','markdown');
    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]');
    await d.wait("app.workspace.activeLeaf.view.getViewType()==='app-view'");
    await d.nav('_qa-B.md','markdown'); await d.nav('_qa-A.md','app-view');
    assert.equal(await d.evaluate("document.querySelectorAll('.workspace-leaf.mod-active .view-action[aria-label*=返回详细版]').length"),1);
  });
} finally {
  await fs.writeFile('artifacts/qa-navigation-results.json',JSON.stringify({results},null,2));
  d.close();
}
