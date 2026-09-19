import fs from 'node:fs/promises';
import { connect } from './cdp.mjs';

const cdp = await connect();
try {
  await cdp.evaluate(`(() => {
    window.__navigationTrace = [];
    window.__navigationRefs = [];
    for (const event of ['file-open', 'active-leaf-change', 'layout-change']) {
      window.__navigationRefs.push(app.workspace.on(event, () => {
        window.__navigationTrace.push({event, time: performance.now(), active: app.workspace.activeLeaf?.getViewState(),
          leaves: app.workspace.getLeavesOfType('markdown').concat(app.workspace.getLeavesOfType('app-view')).map(l => ({id: l.id, state: l.getViewState()})),
          settings: JSON.parse(JSON.stringify(app.plugins.plugins['app-view'].settings))});
      }));
    }
  })()`);
  const click = async selector => {
    const rect = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView(); const r=el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', {type, button: 'left', clickCount: 1, ...rect});
    await new Promise(r => setTimeout(r, 700));
    console.log(selector, JSON.stringify(await cdp.evaluate('app.workspace.activeLeaf.getViewState()')));
  };
  await click('.nav-file-title[data-path="兼容性样例.md"]');
  await click('.nav-file-title[data-path="开始体验.md"]');
  await click('.nav-file-title[data-path="兼容性样例.md"]');
  const trace = await cdp.evaluate('window.__navigationTrace');
  await fs.writeFile('artifacts/navigation-before.json', JSON.stringify(trace, null, 2));
  console.log(JSON.stringify(trace, null, 2));
} finally {
  await cdp.evaluate('window.__navigationRefs.forEach(r => app.workspace.offref(r))');
  cdp.close();
}
