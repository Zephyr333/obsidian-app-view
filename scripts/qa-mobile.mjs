import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {driver} from './qa-driver.mjs';
const d=await driver();const results=[];
try {
  await d.evaluate('app.emulateMobile(true)');
  await d.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await d.wait("typeof app!=='undefined' && app.workspace?.layoutReady && !!app.plugins.plugins['app-view'] && app.isMobile");
  await d.evaluate("(async()=>{app.workspace.leftSplit.collapse();app.workspace.rightSplit.collapse();await app.plugins.plugins['app-view'].openSource('开始体验.md');})()");
  await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]');
  await d.wait("app.workspace.activeLeaf.view.getViewType()==='app-view' && !!document.querySelector('.workspace-leaf.mod-active .app-view-section')");
  await d.evaluate("app.commands.executeCommandById('app-view:toggle-ranges')");
  await d.wait("!!document.querySelector('.workspace-leaf.mod-active .app-view-floating-bar')");
  const layout=await d.evaluate(`(()=>{const root=app.workspace.activeLeaf.view.contentEl;const bar=document.querySelector('.workspace-leaf.mod-active .app-view-floating-bar');return {width:root.clientWidth,scroll:root.scrollWidth,viewport:window.innerWidth,bar:bar.getBoundingClientRect().toJSON(),buttons:[...document.querySelectorAll('.workspace-leaf.mod-active .app-view-locate-btn,.workspace-leaf.mod-active .app-view-manage-del,.workspace-leaf.mod-active .app-view-floating-btn')].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))};})()`);
  assert.ok(layout.scroll<=layout.width+1,JSON.stringify(layout));
  assert.ok(layout.bar.left>=0 && layout.bar.right<=layout.viewport,JSON.stringify(layout));
  assert.ok(layout.buttons.every(b=>b.width>=44&&b.height>=44),JSON.stringify(layout));
  results.push('390 x 844 mobile simulation: projection and management bar fit, plugin buttons >=44px');
  await d.screenshot('release-mobile');
  await d.click('.workspace-leaf.mod-active .app-view-floating-btn.mod-cta');
  await d.wait("!document.querySelector('.workspace-leaf.mod-active .app-view-floating-bar')");
  await d.click('.workspace-leaf.mod-active .view-action[aria-label*="返回详细版"]');
  await d.wait("app.workspace.activeLeaf.view.getViewType()==='markdown'");
  results.push('mobile command toggles quick management and header returns to detail');
  console.log(results.map(r=>'PASS '+r).join('\n'));
} finally {
  await d.evaluate('app.emulateMobile(false)');
  await d.send('Emulation.clearDeviceMetricsOverride');
  await d.wait("typeof app!=='undefined' && app.workspace?.layoutReady && !!app.plugins.plugins['app-view'] && !app.isMobile");
  await fs.writeFile('artifacts/qa-mobile-results.json',JSON.stringify({results,actualPhoneTested:false},null,2));
  d.close();
}
