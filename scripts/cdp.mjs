// Local test profile only. Never attach this helper to a personal vault.
import fs from 'node:fs/promises';
export async function connect() {
  const pages = await (await fetch('http://127.0.0.1:9237/json/list')).json();
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
  const send = (method, params = {}) => new Promise((resolve, reject) => { pending.set(++id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  if (await evaluate('app.vault.adapter.getBasePath()') !== 'F:\\Temp\\app-view\\test-vault') { socket.close(); throw new Error('Wrong vault'); }
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
