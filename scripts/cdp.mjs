// Local test profile only. Never attach this helper to a personal vault.
import fs from 'node:fs/promises';
export async function connect() {
  let pages;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      pages = await (await fetch('http://127.0.0.1:9237/json/list', { signal: AbortSignal.timeout(1000) })).json();
      break;
    } catch {
      if (attempt === 0) {
        const { spawn } = await import('node:child_process');
        const path = await import('node:path');
        const proc = spawn(process.env.OBSIDIAN_EXE ?? 'D:\\Obsidian\\Obsidian.exe', [
          `--user-data-dir=${path.resolve('artifacts/profile')}`,
          '--remote-debugging-port=9237'
        ], { stdio: 'ignore', windowsHide: true });
        proc.unref();
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 200));
          try {
            const res = await (await fetch('http://127.0.0.1:9237/json/list', { signal: AbortSignal.timeout(500) })).json();
            if (res.some(p => p.title.includes('test-vault'))) { pages = res; break; }
          } catch {}
        }
      }
    }
  }
  if (!pages) throw new Error('Could not connect to Obsidian CDP at 127.0.0.1:9237');
  const page = pages.find(p => p.type === 'page' && p.url === 'app://obsidian.md/index.html' && p.title.includes('test-vault'));
  if (!page) throw new Error('Isolated test-vault renderer not found');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); message.error ? waiter.reject(message.error) : waiter.resolve(message.result); }
  };
  socket.onclose = event => {
    for (const waiter of pending.values()) waiter.reject(new Error(`WebSocket closed: ${event.reason || event.code}`));
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const path = await import('node:path');
  const expectedVault = path.resolve('test-vault');
  const actualVault = path.resolve(await evaluate('app.vault.adapter.getBasePath()'));
  if (actualVault.toLowerCase() !== expectedVault.toLowerCase()) { socket.close(); throw new Error(`Wrong vault: expected ${expectedVault}, got ${actualVault}`); }
  return { send, evaluate, close: () => socket.close() };
}
if (process.argv[1]?.endsWith('cdp.mjs')) {
  const cdp = await connect();
  try {
    if (process.argv[2] === 'screenshot') {
      const result = await cdp.send('Page.captureScreenshot');
      await fs.writeFile(process.argv[3], Buffer.from(result.data, 'base64'));
      console.log(process.argv[3]);
    } else console.log(JSON.stringify(await cdp.evaluate(process.argv[3]), null, 2));
  } finally { cdp.close(); }
}
