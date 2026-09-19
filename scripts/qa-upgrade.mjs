import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { driver } from './qa-driver.mjs';

const results = [];
const run = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name); };

const pluginDir = 'test-vault/.obsidian/plugins/app-view';
const dataJsonPath = `${pluginDir}/data.json`;
const baselineDir = 'artifacts/baseline-source';
const packageInstallDir = 'artifacts/package-install/app-view';

const d = await driver();

try {
  // 1. Baseline 0.2.0 installation and legacy data setup
  await run('upgrade from 0.2.0 baseline preserves settings and recovers cleanly', async () => {
    // Copy baseline 0.2.0 build
    await fs.copyFile(`${baselineDir}/main.js`, `${pluginDir}/main.js`);
    await fs.copyFile(`${baselineDir}/manifest.json`, `${pluginDir}/manifest.json`);
    await fs.copyFile(`${baselineDir}/styles.css`, `${pluginDir}/styles.css`);

    // Legacy settings data from 0.2.0
    const legacySettings = {
      viewName: '速查版',
      noteStates: {
        '开始体验.md': 'app',
        '使用说明.md': 'detail'
      },
      markdownStates: {
        '使用说明.md': { mode: 'source', source: false }
      }
    };
    await fs.writeFile(dataJsonPath, JSON.stringify(legacySettings, null, 2), 'utf8');

    // Reload plugin as 0.2.0
    await d.evaluate(`(async () => {
      await app.plugins.loadManifests();
      await app.plugins.disablePlugin('app-view');
      await app.plugins.enablePlugin('app-view');
    })()`);

    const v0 = await d.evaluate("app.plugins.plugins['app-view'].manifest.version");
    assert.equal(v0, '0.2.0', 'baseline version must be 0.2.0');

    // Now upgrade to 1.0.0 by deploying release package files
    await fs.copyFile(`${packageInstallDir}/main.js`, `${pluginDir}/main.js`);
    await fs.copyFile(`${packageInstallDir}/manifest.json`, `${pluginDir}/manifest.json`);
    await fs.copyFile(`${packageInstallDir}/styles.css`, `${pluginDir}/styles.css`);

    // Reload plugin as 1.0.0
    await d.evaluate(`(async () => {
      await app.plugins.loadManifests();
      await app.plugins.disablePlugin('app-view');
      await app.plugins.enablePlugin('app-view');
    })()`);

    const v1 = await d.evaluate("app.plugins.plugins['app-view'].manifest.version");
    assert.equal(v1, '1.0.0', 'upgraded version must be 1.0.0');

    const upgradedSettings = await d.evaluate("app.plugins.plugins['app-view'].settings");
    assert.equal(upgradedSettings.viewName, '速查版');
    assert.equal(upgradedSettings.noteStates['开始体验.md'], 'app');
    assert.equal(upgradedSettings.noteStates['使用说明.md'], 'detail');
    assert.equal(upgradedSettings.markdownStates['使用说明.md']?.mode, 'source');
  });

  // 2. Clean installation with no pre-existing data.json
  await run('clean install without prior data.json initializes default preferences', async () => {
    await fs.rm(dataJsonPath, { force: true });

    await d.evaluate(`(async () => {
      await app.plugins.disablePlugin('app-view');
      await app.plugins.enablePlugin('app-view');
    })()`);

    const cleanSettings = await d.evaluate("app.plugins.plugins['app-view'].settings");
    assert.equal(cleanSettings.viewName, '速查版');
    assert.deepEqual(cleanSettings.noteStates, {});
    assert.deepEqual(cleanSettings.markdownStates, {});

    // Save and verify data.json created with clean defaults
    await d.evaluate("app.plugins.plugins['app-view'].saveSettings()");
    const fileContent = JSON.parse(await fs.readFile(dataJsonPath, 'utf8'));
    assert.equal(fileContent.viewName, '速查版');
  });

  // 3. Re-verify navigation works from clean state
  await run('navigation works immediately after clean install', async () => {
    await d.evaluate(`(async () => {
      const keep = app.workspace.getLeaf(false);
      for (const l of app.workspace.getLeavesOfType('markdown').concat(app.workspace.getLeavesOfType('app-view'))) {
        if (l !== keep) l.detach();
      }
      await keep.openFile(app.vault.getAbstractFileByPath('开始体验.md'), { active: true });
    })()`);

    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="查看速查版"]');
    await d.wait("app.workspace.activeLeaf.view.getViewType() === 'app-view'");

    await d.click('.workspace-leaf.mod-active .view-action[aria-label*="返回详细版"]');
    await d.wait("app.workspace.activeLeaf.view.getViewType() === 'markdown'");
  });
} finally {
  d.close();
  await fs.writeFile('artifacts/qa-upgrade-results.json', JSON.stringify({ results }, null, 2));
}
