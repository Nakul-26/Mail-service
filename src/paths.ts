import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The project root (the directory with package.json), from src/ under tsx or dist/src/ when built. */
export const projectRoot = (() => {
  let dir = import.meta.dirname;
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('package.json not found above ' + import.meta.dirname);
    dir = parent;
  }
  return dir;
})();

export const projectPath = (...parts: string[]) => join(projectRoot, ...parts);
