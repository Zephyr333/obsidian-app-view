import { spawn } from 'node:child_process';
import path from 'node:path';

const exe = process.env.OBSIDIAN_EXE ?? 'D:\\Obsidian\\Obsidian.exe';
const profile = path.resolve('artifacts/profile');
const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=9237'];

console.log(`Starting Obsidian: ${exe}`);
const proc = spawn(exe, args, { stdio: 'inherit' });

proc.on('exit', (code, sig) => {
  console.log(`Obsidian exited with code ${code}, sig ${sig}`);
  process.exit(code ?? 0);
});

// Keep process running
setInterval(() => {}, 60000);
