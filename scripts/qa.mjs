import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connect } from './cdp.mjs';

const cdp = await connect();
const results = [];
const run = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`); };
const evaluate = cdp.evaluate;
const waitFor = async expression => {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 80)); }
  throw new Error(`Timed out: ${expression}`);
};
const click = async selector => {
  await waitFor(`document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`);
  const rect = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)}); if(!el)throw new Error('Missing button'); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...rect });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...rect });
};
const screenshot = async name => { const result = await cdp.send('Page.captureScreenshot'); await fs.writeFile(`artifacts/${name}.png`, Buffer.from(result.data, 'base64')); };
const sourceView = 'app.workspace.getLeavesOfType("markdown").find(l=>l.view.file?.path==="开始体验.md").view';
const appView = 'app.workspace.getLeavesOfType("app-view")[0].view';

try {
  if (await evaluate('app.isMobile')) {
    await evaluate('app.emulateMobile(false)');
    await new Promise(r => setTimeout(r, 500));
    await waitFor('typeof app!=="undefined" && app.workspace?.layoutReady && !!app.plugins.plugins["app-view"] && !app.isMobile');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
  await evaluate('require("electron").remote.getCurrentWindow().setSize(1100,850)');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await evaluate('app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("开始体验.md"))');
  await evaluate(`(()=>{window.__qaErrors=[];window.addEventListener('error',e=>window.__qaErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__qaErrors.push(String(e.reason)));return true})()`);
  await run('Live Preview stays active and range adjustment shows real boundaries', async () => {
    await evaluate(`app.workspace.revealLeaf(${sourceView}.leaf)`);
    if (await evaluate('app.plugins.plugins["app-view"].editing')) await evaluate('app.commands.executeCommandById("app-view:toggle-ranges")');
    assert.equal(await evaluate(`${sourceView}.getState().source`), false);
    assert.ok(await evaluate('document.querySelectorAll(".app-view-boundary").length > 0'));
    await click('.app-view-source-toolbar button:nth-child(2)');
    assert.ok(await evaluate('document.querySelectorAll(".app-view-marker-edit").length > 0 && document.querySelectorAll(".app-view-selected-line").length > 0'));
    await screenshot('ranges');
    await click('.app-view-source-toolbar button:nth-child(2)');
  });
  await run('Application renders selected ranges in order, excluding explanations', async () => {
    await click('.app-view-source-toolbar button:first-child');
    await waitFor('document.querySelector(".app-view-status")?.textContent.startsWith("2 个范围")');
    const text = await evaluate('document.querySelector(".app-view-body").textContent');
    assert.ok(text.includes('确认条件') && text.includes('留下反馈'));
    assert.ok(text.indexOf('确认条件') < text.indexOf('留下反馈'));
    assert.ok(!text.includes('这里是详细推理'));
    assert.equal(await evaluate('document.querySelectorAll(".app-view-body table").length'), 1);
    assert.ok(await evaluate('[...document.querySelectorAll(".app-view-body input")].every(e=>e.disabled)'));
    await screenshot('application');
  });
  await run('Return button preserves the editor and selection', async () => {
    await click('.app-view-toolbar button');
    await waitFor('app.workspace.activeLeaf.view.getViewType()==="markdown"');
    assert.equal(await evaluate('app.workspace.activeLeaf.view.getState().source'), false);
  });
  await run('Toolbar wraps a selection, supports undo, redo, and cancellation', async () => {
    await evaluate(`(()=>{const e=${sourceView}.editor;window.__qaOriginal=e.getValue();const s=e.getValue();const from=s.indexOf('选中这一整段');const to=s.indexOf(String.fromCharCode(10),from);e.setSelection(e.offsetToPos(from),e.offsetToPos(to));e.focus()})()`);
    await click('.app-view-source-toolbar button:nth-child(2)');
    await click('.app-view-source-toolbar button:nth-child(3)');
    assert.equal(await evaluate(`${sourceView}.editor.getValue().split('%%app%%').length`), 5); // three ranges plus a fenced example
    await evaluate(`${sourceView}.editor.undo()`);
    assert.equal(await evaluate(`${sourceView}.editor.getValue()===window.__qaOriginal`), true);
    await evaluate(`${sourceView}.editor.redo()`);
    await evaluate(`(()=>{const e=${sourceView}.editor;e.setCursor(e.offsetToPos(e.getValue().indexOf('选中这一整段')));e.focus()})()`);
    await click('.app-view-source-toolbar button:nth-child(4)');
    assert.equal(await evaluate(`${sourceView}.editor.getValue()===window.__qaOriginal`), true);
    await click('.app-view-source-toolbar button:nth-child(2)');
  });
  await run('Editing and undo automatically update the already open projection', async () => {
    await evaluate(`(()=>{const e=${sourceView}.editor;const p=e.getValue().indexOf('先明确');e.replaceRange('自动同步验证：',e.offsetToPos(p))})()`);
    await waitFor('document.querySelector(".app-view-body")?.textContent.includes("自动同步验证：")');
    await evaluate(`${sourceView}.editor.undo()`);
    await waitFor('!document.querySelector(".app-view-body")?.textContent.includes("自动同步验证：")');
  });
  await run('Cross-boundary deletion and undo do not corrupt the document', async () => {
    await evaluate(`(()=>{const e=${sourceView}.editor;const s=e.getValue();const p=s.indexOf('%%app%%');e.setSelection(e.offsetToPos(p),e.offsetToPos(p+10));e.focus()})()`);
    assert.ok(await evaluate('document.querySelector(".app-view-marker-quiet")?.textContent.includes("%%app%%")'));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
    await waitFor('document.querySelector(".app-view-status")?.textContent.includes("范围需要修正")');
    assert.equal(await evaluate('document.querySelector(".app-view-body").textContent'), '');
    await evaluate(`${sourceView}.editor.undo()`);
    assert.equal(await evaluate(`${sourceView}.editor.getValue()===window.__qaOriginal`), true);
    await waitFor('document.querySelector(".app-view-status")?.textContent.startsWith("2 个范围")');
  });
  await run('Rapid edits settle on the latest contents', async () => {
    await evaluate(`(()=>{const e=${sourceView}.editor;const p=e.getValue().indexOf('先明确');for(let i=0;i<12;i++){e.replaceRange('快',e.offsetToPos(p))}})()`);
    await waitFor('document.querySelector(".app-view-body").textContent.includes("快".repeat(12))');
    await evaluate(`${sourceView}.editor.setValue(window.__qaOriginal)`);
    await waitFor('!document.querySelector(".app-view-body").textContent.includes("快快")');
  });
  await run('Renaming a source preserves its projection association', async () => {
    await evaluate('app.vault.rename(app.vault.getAbstractFileByPath("开始体验.md"),"临时重命名.md")');
    await waitFor(`${appView}.path==="临时重命名.md"`);
    await evaluate('app.vault.rename(app.vault.getAbstractFileByPath("临时重命名.md"),"开始体验.md")');
    await waitFor(`${appView}.path==="开始体验.md"`);
  });
  await run('Mobile emulation provides working switch and return buttons without overflow', async () => {
    assert.deepEqual(await evaluate('window.__qaErrors'), []);
    await evaluate('app.emulateMobile(true)');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await new Promise(r => setTimeout(r, 500));
    await waitFor('typeof app!=="undefined" && app.workspace?.layoutReady && !!app.plugins.plugins["app-view"] && app.isMobile');
    await evaluate('(()=>{window.__qaErrors=[];window.addEventListener("error",e=>window.__qaErrors.push(e.message));window.addEventListener("unhandledrejection",e=>window.__qaErrors.push(String(e.reason)))})()');
    await evaluate('app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("开始体验.md"))');
    await evaluate('app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse()');
    await waitFor('document.body.classList.contains("is-mobile")');
    await click('.app-view-source-toolbar button:first-child');
    await waitFor('app.workspace.activeLeaf.view.getViewType()==="app-view"');
    const widths = await evaluate('(()=>{const e=document.querySelector(".app-view-container");return {client:e.clientWidth,scroll:e.scrollWidth,button:document.querySelector(".app-view-toolbar button").getBoundingClientRect().height}})()');
    assert.ok(widths.scroll <= widths.client + 1, JSON.stringify(widths));
    assert.ok(widths.button >= 44);
    await screenshot('mobile');
    await click('.app-view-toolbar button');
    await waitFor('app.workspace.activeLeaf.view.getViewType()==="markdown"');
    assert.equal(await evaluate('app.workspace.activeLeaf.view.getState().source'), false);
    assert.deepEqual(await evaluate('window.__qaErrors'), []);
    await evaluate('app.emulateMobile(false)');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await new Promise(r => setTimeout(r, 500));
    await waitFor('typeof app!=="undefined" && app.workspace?.layoutReady && !!app.plugins.plugins["app-view"] && !app.isMobile');
  });
  await fs.writeFile('artifacts/qa-results.json', JSON.stringify({ version: '0.1.0', obsidian: '1.13.7', results, actualPhoneTested: false }, null, 2));
} finally { cdp.close(); }
