import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';

/** Preserve runtime arguments and grant proposed menus to this local VSIX only. */
export async function enableLocalProposals(file, extensionId) {
  const original = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}\n'; throw error; });
  const errors = [], args = parse(original, errors, { allowTrailingComma: true });
  if (errors.length || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`Invalid VS Code runtime arguments: ${file}`);
  const enabled = args['enable-proposed-api'] ?? [];
  if (!Array.isArray(enabled) || enabled.some(value => typeof value !== 'string')) throw new Error(`Expected enable-proposed-api to be an array: ${file}`);
  if (enabled.includes(extensionId)) return false;
  const updated = applyEdits(original, modify(original, ['enable-proposed-api'], [...enabled, extensionId], { formattingOptions: { insertSpaces: true, tabSize: 2, eol: original.includes('\r\n') ? '\r\n' : '\n' } }));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.agent-dock-backup`, original, { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await writeFile(file, updated);
  return true;
}
