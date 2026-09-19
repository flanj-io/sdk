import { dirname, join } from 'node:path';

/** `flanj-sdk` — the final fallback when nothing else names the service. */
const FALLBACK = 'flanj-sdk';

/**
 * The injectable inputs {@link resolveAppName} needs — real `process.argv[1]` /
 * `process.cwd()` / `fs.realpathSync` / a file reader in production, literal
 * values and fakes in tests.
 */
export interface ResolveAppNameInput {
  /** `process.argv[1]` — the entry file path, or undefined (embedded interpreter, some REPLs). */
  argv1: string | undefined;
  /** `process.cwd()`. */
  cwd: string;
  /** Reads a file as UTF-8 text; throws when it cannot (missing, unreadable, …). */
  readFile: (path: string) => string;
  /** Resolves symlinks (`fs.realpathSync`); throws when the path does not exist. */
  realpath: (path: string) => string;
}

/**
 * The app's own name (CONTRACTS §2, "Resource attributes", TypeScript rule):
 * the non-empty string `name` of the nearest `package.json`, walking up from
 * the directory of the entry file (`argv1`, symlinks resolved as Node resolves
 * the main module — falling back to the path as given if that throws), and
 * when that finds none, walking up from the working directory. A REPL / `node
 * -e` / `node -p` / stdin entry (`argv1` missing or `"-"`), or no such
 * `package.json` anywhere above either starting point, yields `"flanj-sdk"`.
 *
 * Unparseable JSON, or a `package.json` whose `name` is not a non-empty
 * string, is skipped — the walk keeps going past it.
 */
export function resolveAppName(input: ResolveAppNameInput): string {
  const { argv1, cwd, readFile, realpath } = input;
  if (argv1 === undefined || argv1 === '-') return FALLBACK;

  let entryPath: string;
  try {
    entryPath = realpath(argv1);
  } catch {
    entryPath = argv1;
  }

  return (
    nearestPackageName(dirname(entryPath), readFile) ?? nearestPackageName(cwd, readFile) ?? FALLBACK
  );
}

/** Walk from `startDir` up to the filesystem root, returning the first named `package.json` found. */
function nearestPackageName(startDir: string, readFile: (path: string) => string): string | undefined {
  let dir = startDir;
  for (;;) {
    const name = packageNameAt(dir, readFile);
    if (name !== undefined) return name;
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the root
    dir = parent;
  }
}

/** The non-empty string `name` of `<dir>/package.json`, or undefined (missing/unreadable/unparseable/nameless). */
function packageNameAt(dir: string, readFile: (path: string) => string): string | undefined {
  let text: string;
  try {
    text = readFile(join(dir, 'package.json'));
  } catch {
    return undefined;
  }
  try {
    const pkg = JSON.parse(text) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}
