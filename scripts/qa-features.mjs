import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {driver} from './qa-driver.mjs';
const d=await driver();
const results=[];
const run=async(name,fn)=>{await fn();results.push(name);console.log('PASS',name);};
const source='# Feature QA\n\nNot collected.\n\n%%app%%\n## First\n\n```md\n- [ ] fake task\n%%app%%\n%%/app%%\n```\n\n1. [ ] ordered task\n> - [ ] quoted task\n- [ ] actual task\n\n[[使用说明]]\n%%/app%%\n\nOutside paragraph.\n\n%%app%%\n## Second\n\n- Another list\n%%/app%%\n';
const fixture='_qa-features.md';
const setup=async()=>{
  await d.evaluate(`(async()=>{
    const p=app.plugins.plugins['app-view'];if(p.isEditing())p.toggleRanges();
    const keep=app.workspace.getLeaf(false);
    for(const l of app.workspace.getLeavesOfType('markdown').concat(app.workspace.getLeavesOfType('app-view'))) if(l!==keep)l.detach();
    await keep.setViewState({type:'empty',active:true});
    const f=app.vault.getAbstractFileByPath(${JSON.stringify(fixture)});
    if(f) await app.vault.modify(f,${JSON.stringify(source)});else await app.vault.create(${JSON.stringify(fixture)},${JSON.stringify(source)});
    p.settings.noteStates[${JSON.stringify(fixture)}]='detail';
    p.settings.markdownStates[${JSON.stringify(fixture)}]={mode:'source',source:false};
    await keep.openFile(app.vault.getAbstractFileByPath(${JSON.stringify(fixture)}),{active:true});
    window.__featureErrors=[];
    if(!window.__featureErrorListener){window.__featureErrorListener=e=>window.__featureErrors.push(e.message??String(e.reason));window.addEventListener('error',window.__featureErrorListener);window.addEventListener('unhandledrejection',window.__featureErrorListener);}
  })()`);
};
const quick=async()=>{
  await d.wait('!app.workspace.activeLeaf?.working');
  await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]');
  try {
    await d.wait("app.workspace.activeLeaf.view.getViewType()==='app-view' && document.querySelector('.workspace-leaf.mod-active .app-view-section')", 'quick transition', 3000);
  } catch {
    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]');
    await d.wait("app.workspace.activeLeaf.view.getViewType()==='app-view' && document.querySelector('.workspace-leaf.mod-active .app-view-section')");
  }
};
const detail=async()=>{
  await d.wait('!app.workspace.activeLeaf?.working');
  await d.click('.workspace-leaf.mod-active .view-action[aria-label*="返回详细版"]');
  try {
    await d.wait("app.workspace.activeLeaf.view.getViewType()==='markdown' && !app.workspace.activeLeaf.working", 'detail transition', 3000);
  } catch {
    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="返回详细版"]');
    await d.wait("app.workspace.activeLeaf.view.getViewType()==='markdown' && !app.workspace.activeLeaf.working");
  }
};
try {
  await setup();
  await run('Live Preview hides real marker lines and right-click exposes adjustment',async()=>{
    await d.wait('document.querySelectorAll(".app-view-marker-hidden").length===4');
    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]',{button:'right'});
    await d.wait('document.querySelectorAll(".app-view-marker-edit").length===4 && !!document.querySelector(".app-view-floating-bar")');
    await d.click('.app-view-floating-btn.mod-cta');
    await d.wait('!document.querySelector(".app-view-floating-bar")');
  });
  await run('selection add/remove and undo/redo preserve source exactly',async()=>{
    await d.evaluate(`(()=>{const e=app.workspace.activeLeaf.view.editor;const from=e.getValue().indexOf('Outside paragraph.');e.setSelection(e.offsetToPos(from),e.offsetToPos(from+'Outside paragraph.'.length));app.commands.executeCommandById('app-view:include-selection');})()`);
    assert.ok((await d.evaluate('app.workspace.activeLeaf.view.editor.getValue()')).includes('%%app%%\nOutside paragraph.\n%%/app%%'));
    await d.evaluate('app.workspace.activeLeaf.view.editor.undo()');
    assert.equal(await d.evaluate('app.workspace.activeLeaf.view.editor.getValue()'),source);
    await d.evaluate('app.workspace.activeLeaf.view.editor.redo()');
    await d.evaluate("(()=>{const e=app.workspace.activeLeaf.view.editor;e.setCursor(e.offsetToPos(e.getValue().indexOf('Outside paragraph.')));app.commands.executeCommandById('app-view:exclude-range');})()");
    assert.equal(await d.evaluate('app.workspace.activeLeaf.view.editor.getValue()'),source);
  });
  await run('projection is ordered, excludes outside prose, renders actual task inputs',async()=>{
    await quick();
    const text=await d.evaluate('document.querySelector(".workspace-leaf.mod-active .app-view-body").innerText');
    assert.ok(text.indexOf('First')<text.indexOf('Second'));
    assert.ok(!text.includes('Not collected.')&&!text.includes('Outside paragraph.'));
    assert.equal(await d.evaluate('document.querySelectorAll(".app-view-body input.task-list-item-checkbox:not(:disabled)").length'),3);
  });
  await run('checkbox writes exactly the intended task, not fenced examples',async()=>{
    await d.click('.app-view-body input.task-list-item-checkbox');
    await d.wait('document.querySelector(".app-view-body input.task-list-item-checkbox")?.checked===true');
    assert.equal(await d.evaluate(`app.vault.read(app.vault.getAbstractFileByPath('${fixture}'))`),source.replace('1. [ ] ordered','1. [x] ordered'));
    await d.click('.app-view-body input.task-list-item-checkbox');
    await d.wait('document.querySelector(".app-view-body input.task-list-item-checkbox")?.checked===false');
    assert.equal(await d.evaluate(`app.vault.read(app.vault.getAbstractFileByPath('${fixture}'))`),source);
  });
  await run('management remove rejects a stale projection without deleting other content',async()=>{
    const value=await d.evaluate(`(async()=>{const p=app.plugins.plugins['app-view'];const f=app.vault.getAbstractFileByPath('${fixture}');const v=app.workspace.activeLeaf.view;const section=v.contentEl.querySelector('.app-view-section');const old=await app.vault.read(f);const next='New prefix\\n'+old;await app.vault.modify(f,next);await p.removeRangeAt(f.path,Number(section.dataset.from),Number(section.dataset.to),old);return {actual:await app.vault.read(f),expected:next};})()`);
    assert.equal(value.actual,value.expected);
    await d.evaluate(`app.vault.modify(app.vault.getAbstractFileByPath('${fixture}'),${JSON.stringify(source)})`);
    await d.wait("app.workspace.activeLeaf.view.lastText==="+JSON.stringify(source));
  });
  await run('manage/remove section and clear markers preserve code and prose',async()=>{
    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="返回详细版"]',{button:'right'});
    await d.click('.app-view-section:last-child .app-view-manage-del');
    await d.wait('document.querySelectorAll(".app-view-section").length===1');
    assert.ok((await d.evaluate(`app.vault.read(app.vault.getAbstractFileByPath('${fixture}'))`)).includes('## Second\n\n- Another list'));
    await d.click('.app-view-floating-bar button:nth-of-type(2)');
    await d.wait('document.querySelectorAll(".app-view-section").length===0');
    const expected=source.replace('%%app%%\n## First','## First').replace('[[使用说明]]\n%%/app%%','[[使用说明]]').replace('%%app%%\n## Second','## Second').replace('- Another list\n%%/app%%\n','- Another list\n');
    assert.equal(await d.evaluate(`app.vault.read(app.vault.getAbstractFileByPath('${fixture}'))`),expected);
    await detail();
    await d.evaluate(`app.workspace.activeLeaf.view.editor.setValue(${JSON.stringify(source)})`);
  });
  await run('editor clear-all is undoable and preserves code sample markers',async()=>{
    await d.evaluate("app.commands.executeCommandById('app-view:clear-all-ranges')");
    const text=await d.evaluate('app.workspace.activeLeaf.view.editor.getValue()');
    assert.ok(text.includes('```md\n- [ ] fake task\n%%app%%\n%%/app%%\n```'));
    await d.evaluate('app.workspace.activeLeaf.view.editor.undo()');
    assert.equal(await d.evaluate('app.workspace.activeLeaf.view.editor.getValue()'),source);
  });
  await run('detail/quick split updates from edits, checkbox changes can undo in editor',async()=>{
    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]',{modifiers:6});
    await d.wait("app.workspace.activeLeaf.view.getViewType()==='app-view'");
    await d.click('.workspace-leaf.mod-active .app-view-body input.task-list-item-checkbox');
    await d.wait("app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='_qa-features.md').view.editor.getValue().includes('1. [x] ordered')");
    await d.evaluate("app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='_qa-features.md').view.editor.undo()");
    await d.wait('document.querySelector(".app-view-body input.task-list-item-checkbox")?.checked===false');
    await d.evaluate("(()=>{const e=app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='_qa-features.md').view.editor;const pos=e.offsetToPos(e.getValue().indexOf('## First'));e.replaceRange('EDITED ',pos);})()");
    await d.wait('document.querySelector(".app-view-body")?.textContent.includes("EDITED")');
    await d.evaluate("app.workspace.getLeavesOfType('markdown').find(l=>l.view.file?.path==='_qa-features.md').view.editor.undo()");
    await d.wait('!document.querySelector(".app-view-body")?.textContent.includes("EDITED")');
  });
  await run('plain-text copy omits management controls and Markdown formatting',async()=>{
    const copied=await d.evaluate(`(async()=>{const v=app.workspace.activeLeaf.view;v.toggleManaging();const original=navigator.clipboard.writeText;let copied='';navigator.clipboard.writeText=async text=>{copied=text;};try{await v.copyContent();}finally{navigator.clipboard.writeText=original;v.toggleManaging();}return copied;})()`);
    assert.ok(copied.includes('ordered task')&&!copied.includes('移除本段')&&!copied.includes('## First'));
    const copyEvent=await d.evaluate(`(()=>{const v=app.workspace.activeLeaf.view;window.getSelection().removeAllRanges();const data=new DataTransfer();v.contentEl.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain');})()`);
    assert.equal(copyEvent,copied);
  });
  await run('source locate switches to editor at the selected range',async()=>{
    await d.click('.workspace-leaf.mod-active .app-view-section:last-child .app-view-locate-btn');
    await d.wait("app.workspace.activeLeaf.view.getViewType()==='markdown' && app.workspace.activeLeaf.view.getMode()==='source'");
    assert.equal(await d.evaluate('app.workspace.activeLeaf.view.editor.getLine(app.workspace.activeLeaf.view.editor.getCursor().line)'),'## Second');
  });
  await run('compatibility rendering: image, callout, code, math and separate lists',async()=>{
    await d.evaluate("app.plugins.plugins['app-view'].openApplication(app.vault.getAbstractFileByPath('兼容性样例.md'))");
    await d.wait('document.querySelector(".workspace-leaf.mod-active .app-view-body img")?.naturalWidth>0 && !!document.querySelector(".workspace-leaf.mod-active mjx-container")');
    const stats=await d.evaluate("(()=>{const b=app.workspace.activeLeaf.view.contentEl;return {callouts:b.querySelectorAll('.callout').length,sections:b.querySelectorAll('.app-view-section').length,lists:b.querySelectorAll('.app-view-rendered>ul').length,code:b.querySelector('pre').textContent.trim()}})()");
    assert.deepEqual(stats,{callouts:1,sections:4,lists:2,code:'const action = "先行动，再记录";'});
    await d.screenshot('release-desktop');
  });
  await run('internal link opens the target note without inheriting quick view',async()=>{
    await d.click('.workspace-leaf.mod-active .app-view-body a.internal-link');
    await d.wait("app.workspace.activeLeaf.view.file?.path==='使用说明.md' && app.workspace.activeLeaf.view.getViewType()==='markdown'");
  });
  await run('no-range note stays detailed; malformed markers show an error without partial projection',async()=>{
    await d.evaluate("app.plugins.plugins['app-view'].openApplication(app.vault.getAbstractFileByPath('使用说明.md'))");
    assert.equal(await d.evaluate('app.workspace.activeLeaf.view.getViewType()'),'markdown');
    await d.evaluate(`(async()=>{const f=app.vault.getAbstractFileByPath('${fixture}');await app.plugins.plugins['app-view'].editSource(f,undefined,()=> '%%app%%\\nBroken');await app.plugins.plugins['app-view'].openApplication(f);})()`);
    await d.wait('document.querySelector(".workspace-leaf.mod-active .app-view-empty")?.textContent.includes("结束标记")');
    assert.equal(await d.evaluate('document.querySelectorAll(".workspace-leaf.mod-active .app-view-section").length'),0);
  });
  await run('folder rename migrates both stored modes and existing quick view path',async()=>{
    await d.evaluate(`(async()=>{const p=app.plugins.plugins['app-view'];const folder='_qa-folder';if(!app.vault.getAbstractFileByPath(folder))await app.vault.createFolder(folder);const name=folder+'/note.md';let f=app.vault.getAbstractFileByPath(name);if(!f)f=await app.vault.create(name,'%%app%%\\nMove me\\n%%/app%%');await p.openApplication(f);p.settings.markdownStates[name]={mode:'source',source:true};await app.fileManager.renameFile(app.vault.getAbstractFileByPath(folder),'_qa-moved');})()`);
    await d.wait("app.workspace.activeLeaf.view.path==='_qa-moved/note.md'");
    assert.equal(await d.evaluate("app.plugins.plugins['app-view'].settings.noteStates['_qa-moved/note.md']"),'app');
    assert.equal(await d.evaluate("app.plugins.plugins['app-view'].settings.markdownStates['_qa-moved/note.md'].source"),true);
    await d.evaluate("app.fileManager.trashFile(app.vault.getAbstractFileByPath('_qa-moved'))");
    await d.wait("!('_qa-moved/note.md' in app.plugins.plugins['app-view'].settings.noteStates)");
  });
  await run('no uncaught runtime errors during the feature suite',async()=>{
    assert.deepEqual(await d.evaluate('window.__featureErrors'),[]);
  });
} finally {
  await fs.writeFile('artifacts/qa-features-results.json',JSON.stringify({results},null,2));
  d.close();
}
