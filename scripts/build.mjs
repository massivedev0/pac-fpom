import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = process.cwd();
const distDir = resolve(root, "dist");
const entries = ["index.html", "src", "assets"];

function folderSizeBytes(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const items = readdirSync(current, { withFileTypes: true });
    for (const item of items) {
      const itemPath = join(current, item.name);
      if (item.isDirectory()) {
        stack.push(itemPath);
      } else {
        total += statSync(itemPath).size;
      }
    }
  }
  return total;
}

for (const entry of entries) {
  if (!existsSync(resolve(root, entry))) {
    throw new Error(`Build input not found: ${entry}`);
  }
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

for (const entry of entries) {
  cpSync(resolve(root, entry), resolve(distDir, entry), { recursive: true });
}

// Keep GitHub Pages in pure static mode.
writeFileSync(resolve(distDir, ".nojekyll"), "");

const filesCount = readdirSync(distDir, { recursive: true }).filter((p) => p && !p.endsWith("/")).length;
const bytes = folderSizeBytes(distDir);
const kb = (bytes / 1024).toFixed(1);

console.log(`Build complete: ${filesCount} files in dist (${kb} KB).`);
