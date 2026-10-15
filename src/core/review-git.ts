import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
const options = (project: string) => ({ cwd: project, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

/** Undefined means Git is unavailable; null is a repository before its first commit. */
export async function reviewGitHead(project: string): Promise<string | null | undefined> {
  if (!process.env.GIT_DIR) {
    let directory: string;
    try { directory = await realpath(project); } catch { return undefined; }
    while (true) {
      try { await stat(path.join(directory, '.git')); break; } catch { /* Check the parent for nested workspace roots. */ }
      const parent = path.dirname(directory);
      if (parent === directory) return undefined;
      directory = parent;
    }
  }
  try {
    const { stdout } = await execute('git', ['rev-parse', '--git-dir', '--verify', 'HEAD^{commit}'], options(project));
    const head = stdout.trim().split(/\r?\n/).at(-1)!; return /^[a-f0-9]{40,64}$/.test(head) ? head : undefined;
  } catch (error) {
    return (error as { stdout?: string }).stdout?.trim() ? null : undefined;
  }
}

export async function reviewCommittedPaths(project: string, before: string | null, head: string): Promise<string[]> {
  const args = before ? ['diff', '--name-only', '--no-renames', '--relative', '-z', before, head, '--', '.']
    : ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '--relative', '-r', '-z', head, '--', '.'];
  return (await execute('git', args, options(project))).stdout.split('\0').filter(Boolean);
}

export async function reviewUncommittedPaths(project: string, head: string): Promise<Set<string>> {
  const { stdout } = await execute('git', ['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '--relative', '-z', head, '--', '.'], options(project));
  return new Set(stdout.split('\0').filter(Boolean));
}

/** Compare using the path's clean filters, including attributes that disable CRLF conversion. */
export async function reviewGitEquivalentFiles(project: string, name: string, before: string, after: string): Promise<boolean> {
  const { stdout } = await execute('git', ['hash-object', `--path=${name}`, '--', before, after], options(project));
  const hashes = stdout.trim().split(/\r?\n/);
  return hashes.length === 2 && hashes[0] === hashes[1];
}

/** Stream checkout-form bytes, including Git's CRLF conversion, into snapshot storage. */
export async function reviewCommittedFile(project: string, head: string, name: string, target: string): Promise<'file' | 'deleted' | 'unsupported'> {
  const tree = (await execute('git', ['ls-tree', '-z', head, '--', `:(literal)${name}`], options(project))).stdout;
  // A committed directory replaces the old leaf file; its children are reconciled separately.
  if (!tree || /^040000 tree /.test(tree)) return 'deleted';
  if (!/^100[0-7]{3} blob /.test(tree) || tree.split('\0').filter(Boolean).length !== 1) return 'unsupported';
  const child = spawn('git', ['cat-file', '--filters', `${head}:./${name}`], { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const finished = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Could not read committed review file: ${name}`)));
  });
  try { await Promise.all([pipeline(child.stdout, createWriteStream(target, { flags: 'wx' })), finished]); }
  finally { if (child.exitCode === null) child.kill(); }
  return 'file';
}
