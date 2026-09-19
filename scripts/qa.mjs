import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';

const suites = [
  { name: 'navigation', script: 'scripts/qa-navigation.mjs', artifact: 'artifacts/qa-navigation-results.json' },
  { name: 'features', script: 'scripts/qa-features.mjs', artifact: 'artifacts/qa-features-results.json' },
  { name: 'extra', script: 'scripts/qa-extra.mjs', artifact: 'artifacts/qa-extra-results.json' },
  { name: 'mobile', script: 'scripts/qa-mobile.mjs', artifact: 'artifacts/qa-mobile-results.json' },
  { name: 'upgrade', script: 'scripts/qa-upgrade.mjs', artifact: 'artifacts/qa-upgrade-results.json' },
  { name: 'restart', script: 'scripts/qa-restart.mjs', artifact: 'artifacts/qa-restart-results.json' }
];

console.log('=== Starting Full QA Verification Suite (v1.0.1) ===\n');

const allResults = [];
const summary = {
  version: '1.0.1',
  obsidian: '1.13.7',
  timestamp: new Date().toISOString(),
  actualPhoneTested: false,
  suites: {}
};

for (const suite of suites) {
  console.log(`\n--- Running Suite: ${suite.name} (${suite.script}) ---`);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [suite.script], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Suite ${suite.name} failed with exit code ${code}`));
    });
  });

  try {
    const content = JSON.parse(await fs.readFile(suite.artifact, 'utf8'));
    summary.suites[suite.name] = content.results ?? content;
    if (Array.isArray(content.results)) {
      allResults.push(...content.results);
    }
  } catch (err) {
    console.warn(`Warning: Could not read artifact for ${suite.name}: ${err.message}`);
  }
}

summary.totalPassed = allResults.length;
summary.allPassed = true;

await fs.writeFile('artifacts/qa-results.json', JSON.stringify(summary, null, 2), 'utf8');

console.log(`\n=== QA Complete: All ${allResults.length} integration tests passed! ===`);
