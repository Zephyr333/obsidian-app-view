import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { connect } from './cdp.mjs';
const cdp = await connect();
const results = [];
const file = 'test-vault/兼容性样例.md';
const original = await fs.readFile(file, 'utf8');
const waitFor = async expression => {
  for (let i = 0; i < 70; i++) { if (await cdp.evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`Timed out: ${expression}`);
};
try {
  await cdp.evaluate('app.plugins.plugins["app-view"].openApplication(app.vault.getAbstractFileByPath("兼容性样例.md"))');
  await waitFor('document.querySelector(".app-view-body img")?.naturalWidth>0 && !!document.querySelector(".app-view-body mjx-container")');
  assert.deepEqual(await cdp.evaluate('({callouts:document.querySelectorAll(".app-view-body .callout").length,code:document.querySelector(".app-view-body pre").textContent.trim(),sections:document.querySelectorAll(".app-view-section").length,lists:document.querySelectorAll(".app-view-section>ul").length})'), { callouts: 1, code: 'const action = "先行动，再记录";', sections: 4, lists: 2 });
  results.push('image, callout, code, math and separate lists render');
  await cdp.evaluate('document.querySelector(".app-view-body a.internal-link").click()');
  await waitFor('app.workspace.activeLeaf.view.file?.path==="使用说明.md"');
  results.push('internal link opens the correct note');
  await cdp.evaluate('app.plugins.plugins["app-view"].openApplication(app.vault.getAbstractFileByPath("兼容性样例.md"))');
  await fs.writeFile(file, original.replace('只保留实际操作。', '外部同步验证成功。'));
  await waitFor('document.querySelector(".app-view-body").textContent.includes("外部同步验证成功。")');
  results.push('external filesystem change refreshes the projection');
  await fs.writeFile(file, original);
  await waitFor('document.querySelector(".app-view-body").textContent.includes("只保留实际操作。")');
  await cdp.evaluate('app.plugins.plugins["app-view"].openApplication(app.vault.getAbstractFileByPath("使用说明.md"))');
  await waitFor('document.querySelector(".app-view-status").textContent.includes("还没有应用内容")');
  assert.equal(await cdp.evaluate('document.querySelector(".app-view-body").textContent'), '');
  results.push('notes without ranges have an explicit empty state');
  console.log(results.map(r => `PASS ${r}`).join('\n'));
  await fs.writeFile('artifacts/qa-content-results.json', JSON.stringify(results, null, 2));
} finally { await fs.writeFile(file, original); cdp.close(); }
