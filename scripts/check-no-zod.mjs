import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const failures = [];

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const candidate = path.join(directory, entry);
    if (statSync(candidate).isDirectory()) {
      files.push(...sourceFiles(candidate));
    } else if (candidate.endsWith(".ts")) {
      files.push(candidate);
    }
  }
  return files;
}

for (const sourceRoot of [
  path.join(root, "apps", "bridge", "src"),
  path.join(root, "apps", "bridge", "tests"),
]) {
  for (const file of sourceFiles(sourceRoot)) {
    if (/\bfrom\s+["']zod["']|\brequire\(["']zod["']\)/u.test(readFileSync(file, "utf8"))) {
      failures.push(path.relative(root, file));
    }
  }
}

for (const packageFile of [
  path.join(root, "package.json"),
  path.join(root, "apps", "bridge", "package.json"),
]) {
  const packageText = readFileSync(packageFile, "utf8");
  if (/"zod"\s*:/u.test(packageText)) {
    failures.push(path.relative(root, packageFile));
  }
}

if (failures.length > 0) {
  process.stderr.write(`Zod is forbidden; found references in ${failures.join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("ArkType-only validation check passed.\n");
}
