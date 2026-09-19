import { connect } from './cdp.mjs';
import fs from 'node:fs/promises';
export async function driver() {
  const cdp = await connect();
  const evaluate = cdp.evaluate;
  const wait = async (expression, label = expression, timeout = 8000) => {
    const deadline = Date.now() + timeout;
    do {
      try {
        if (await evaluate(expression)) return;
      } catch (err) {
        if (!String(err?.message ?? JSON.stringify(err)).includes('Execution context was destroyed')) throw err;
      }
      await new Promise(r => setTimeout(r, 50));
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}; state=${JSON.stringify(await evaluate('app.workspace.activeLeaf?.getViewState()').catch(() => null))}`);
  };
  await wait("typeof app !== 'undefined' && !!app.workspace?.layoutReady", "workspace ready", 15000);
  await evaluate("if (!app.plugins?.plugins?.['app-view']) app.plugins?.enablePluginAndSave?.('app-view')");
  await wait("!!app.plugins?.plugins?.['app-view']", "plugin ready", 15000);
  if (await evaluate("Boolean(app.isMobile)")) {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await evaluate("setTimeout(() => app.emulateMobile(false), 0)");
    await wait("typeof app !== 'undefined' && !app.isMobile && !!app.workspace?.layoutReady && !!app.plugins?.plugins?.['app-view']", "exit mobile mode and plugin ready");
  }
  await evaluate(`(async () => {
    if (!app.workspace.rootSplit.children.some(c => c.type === 'tabs')) {
      app.workspace.createLeafInParent(app.workspace.rootSplit, 0);
    }
    if (app.workspace.getLeavesOfType('file-explorer').length === 0) {
      await app.commands.executeCommandById('file-explorer:open');
    }
    app.workspace.leftSplit.expand();
  })()`);
  const click = async (selector, {button = 'left', modifiers = 0, count = 1} = {}) => {
    await wait('!app.workspace.activeLeaf?.working', 'previous native transition completed');
    await wait(`!!document.querySelector(${JSON.stringify(selector)})?.checkVisibility()`, `visible ${selector}`);
    await evaluate("document.querySelectorAll('.notice').forEach(n => n.remove())");
    await wait(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el.contains(top)||top?.closest('.notice')!==null;})()`, `unobscured ${selector}`);
    const rect = await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved', ...rect});
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', {type, button, modifiers, clickCount: count, ...rect});
  };
  const nav = async (path, type, options) => {
    if (!await evaluate('document.querySelector(".nav-file-title") !== null')) {
      await evaluate(`(async () => {
        if (app.workspace.getLeavesOfType('file-explorer').length === 0) {
          await app.commands.executeCommandById('file-explorer:open');
        }
        app.workspace.leftSplit.expand();
      })()`);
      await wait('document.querySelector(".nav-file-title") !== null', 'file explorer tree populated');
    }
    const selector = `.nav-file-title[data-path="${path}"]`;
    await click(selector, options);
    // If not transitioned after 500ms, use element click fallback
    await evaluate(`(async () => {
      await new Promise(r => setTimeout(r, 500));
      if (app.workspace.activeLeaf?.view?.file?.path !== ${JSON.stringify(path)}) {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (el) el.click();
      }
    })()`);
    await wait(`app.workspace.activeLeaf?.view.file?.path===${JSON.stringify(path)} && app.workspace.activeLeaf.view.getViewType()===${JSON.stringify(type)} && !app.workspace.activeLeaf.working`, `open ${path} as ${type}`);
  };
  const screenshot = async name => {
    const result = await cdp.send('Page.captureScreenshot');
    await fs.writeFile(`artifacts/${name}.png`, Buffer.from(result.data, 'base64'));
  };
  return {...cdp, wait, click, nav, screenshot};
}
