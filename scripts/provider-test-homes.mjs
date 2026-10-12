import path from 'node:path';
import os from 'node:os';
import { constants } from 'node:fs';
import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';

/** Live tests reuse sign-in, but own all provider history/config writes.
 * Never link credentials/config or copy transcripts into the test homes.
 */
export async function providerTestHomes(runtime, { reopen = false, sources = process.env, home = os.homedir(), root = process.cwd() } = {}) {
  const relative = path.relative(path.join(root, '.test-runtime'), path.resolve(runtime));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Provider test homes must be inside a dedicated .test-runtime run.');
  const codex = path.join(runtime, 'provider-homes', 'codex'), claude = path.join(runtime, 'provider-homes', 'claude');
  const marker = path.join(runtime, 'provider-homes.json');
  let prepared = false;
  try { prepared = JSON.parse(await readFile(marker, 'utf8')).version === 1; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (reopen && !prepared) throw new Error('This old test runtime used shared CLI history. Start a new isolated test run.');
  if (!prepared) {
    const codexSource = sources.CODEX_HOME || path.join(home, '.codex');
    const claudeSource = sources.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    for (const destination of [codex, claude]) await mkdir(destination, { recursive: true, mode: 0o700 });
    const copy = async (source, destination) => {
      try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
      catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
    };
    for (const file of ['auth.json', 'config.toml']) await copy(path.join(codexSource, file), path.join(codex, file));
    for (const file of ['.credentials.json', 'settings.json']) await copy(path.join(claudeSource, file), path.join(claude, file));
    // Claude's global config also holds projects/history; retain only login
    // metadata rather than importing the user's per-project state.
    try {
      const source = sources.CLAUDE_CONFIG_DIR ? path.join(claudeSource, '.claude.json') : path.join(home, '.claude.json');
      const config = JSON.parse(await readFile(source, 'utf8'));
      const login = Object.fromEntries(['oauthAccount', 'hasCompletedOnboarding', 'primaryApiKey', 'customApiKeyResponses'].filter(key => config[key] !== undefined).map(key => [key, config[key]]));
      await writeFile(path.join(claude, '.claude.json'), JSON.stringify(login), { flag: 'wx', mode: 0o600 });
    } catch (error) { if (!['ENOENT', 'EEXIST'].includes(error.code)) throw error; }
    await writeFile(marker, JSON.stringify({ version: 1 }), { flag: 'wx' });
  }
  return { CODEX_HOME: path.resolve(codex), CLAUDE_CONFIG_DIR: path.resolve(claude) };
}
