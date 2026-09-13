/** True when `file` would land outside the repo. Customer data (addresses, subjects) never goes in it. */
import { realpathSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';

export function isOutsideRepo(file, repoRoot = new URL('..', import.meta.url).pathname) {
  const repo = realpathSync(repoRoot);
  const dir = dirname(resolve(file));
  const rel = relative(repo, existsSync(dir) ? realpathSync(dir) : dir);
  return rel !== '' && (rel.startsWith('..') || isAbsolute(rel));
}
