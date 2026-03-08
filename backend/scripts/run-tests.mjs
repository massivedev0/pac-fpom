import { spawn } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(SCRIPT_DIR, "..");
const PRISMA_DIR = path.join(BACKEND_DIR, "prisma");
const DEFAULT_TEST_DB_PATH = path.join(BACKEND_DIR, "prisma", "rewards.test.db");
const DEFAULT_TEST_DB_URL = "file:./rewards.test.db";

/**
 * Parses CLI flags for the backend test runner
 *
 * @param {string[]} argv Raw CLI arguments
 * @returns {{ syncOnly: boolean }} Parsed runner options
 */
function parseArgs(argv) {
  return {
    syncOnly: argv.includes("--sync-only"),
  };
}

/**
 * Resolves the SQLite URL used for backend tests
 *
 * @returns {string} Prisma-compatible SQLite database URL
 */
function resolveTestDatabaseUrl() {
  return (
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL_TEST ||
    DEFAULT_TEST_DB_URL
  );
}

/**
 * Resolves filesystem path for SQLite database file
 *
 * @param {string} databaseUrl Prisma database URL
 * @returns {string | null} Absolute SQLite file path
 */
function resolveSqliteDatabasePath(databaseUrl) {
  if (!databaseUrl.startsWith("file:")) {
    return null;
  }

  const databasePath = databaseUrl.slice("file:".length);
  if (!databasePath) {
    return null;
  }

  return path.isAbsolute(databasePath)
    ? databasePath
    : path.join(PRISMA_DIR, databasePath.replace(/^\.\//, ""));
}

/**
 * Returns SQLite artifact paths that should be cleared before a fresh test run
 *
 * @param {string} databaseUrl Prisma database URL
 * @returns {string[]} Filesystem paths to remove
 */
function getSqliteArtifactPaths(databaseUrl) {
  const resolvedPath = resolveSqliteDatabasePath(databaseUrl);
  if (!resolvedPath) {
    return [];
  }

  return [
    resolvedPath,
    `${resolvedPath}-journal`,
    `${resolvedPath}-shm`,
    `${resolvedPath}-wal`,
  ];
}

/**
 * Removes stale SQLite files so each test run starts from a clean database
 *
 * @param {string} databaseUrl Prisma database URL
 * @returns {Promise<void>}
 */
async function resetSqliteArtifacts(databaseUrl) {
  const artifactPaths = getSqliteArtifactPaths(databaseUrl);
  await Promise.all(artifactPaths.map((artifactPath) => rm(artifactPath, { force: true })));
}

/**
 * Creates empty SQLite file before Prisma schema sync
 *
 * @param {string} databaseUrl Prisma database URL
 * @returns {Promise<void>}
 */
async function ensureSqliteFileExists(databaseUrl) {
  const databasePath = resolveSqliteDatabasePath(databaseUrl);
  if (!databasePath) {
    return;
  }

  await mkdir(path.dirname(databasePath), { recursive: true });
  await writeFile(databasePath, "", { flag: "a" });
}

/**
 * Resolves a local project binary from `node_modules/.bin`
 *
 * @param {string} name Binary name without platform suffix
 * @returns {string} Absolute binary path
 */
function resolveLocalBinary(name) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  return path.join(BACKEND_DIR, "node_modules", ".bin", `${name}${suffix}`);
}

/**
 * Recursively collects backend test files
 *
 * @param {string} directory Directory to scan
 * @returns {Promise<string[]>} Sorted test file paths relative to backend root
 */
async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path.relative(BACKEND_DIR, absolutePath));
    }
  }

  return files.sort();
}

/**
 * Runs a child process and mirrors stdio to the current terminal
 *
 * @param {string} command Executable path
 * @param {string[]} args CLI arguments
 * @param {NodeJS.ProcessEnv} env Process environment
 * @returns {Promise<void>}
 */
function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: BACKEND_DIR,
      env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `Command terminated by signal ${signal}: ${command}`
            : `Command failed with exit code ${code ?? "unknown"}: ${command}`,
        ),
      );
    });
  });
}

/**
 * Provisions isolated backend test DB, syncs Prisma schema, and runs the test suite
 *
 * @returns {Promise<void>}
 */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const testDatabaseUrl = resolveTestDatabaseUrl();
  const env = {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
    TEST_DATABASE_URL: testDatabaseUrl,
  };

  console.log(`Using isolated test database: ${testDatabaseUrl}`);
  await resetSqliteArtifacts(testDatabaseUrl);
  await ensureSqliteFileExists(testDatabaseUrl);
  await runCommand(resolveLocalBinary("prisma"), ["db", "push", "--skip-generate"], env);

  if (options.syncOnly) {
    return;
  }

  const testFiles = await collectTestFiles(path.join(BACKEND_DIR, "tests"));
  if (testFiles.length === 0) {
    throw new Error("No backend test files found");
  }

  await runCommand(
    resolveLocalBinary("tsx"),
    ["--test", "--test-concurrency=1", ...testFiles],
    env,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
