import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const [mode, target] = process.argv.slice(2);
if (mode === 'tree') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', path.join(target, 'child.txt')], { windowsHide: true, stdio: 'ignore' });
  console.log(child.pid); setInterval(() => undefined, 100);
} else {
  let tick = 0; writeFileSync(target, String(tick));
  setInterval(() => writeFileSync(target, String(++tick)), 40);
}
