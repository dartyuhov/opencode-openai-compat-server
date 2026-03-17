import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distIndexPath = path.join(rootDir, "dist", "index.js");
const distTypesPath = path.join(rootDir, "dist", "index.d.ts");

const run = (command: string[], description: string) => {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: rootDir,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status ?? "unknown"}.`);
  }
};

if (!existsSync(distIndexPath) || !existsSync(distTypesPath)) {
  run([process.execPath, "run", "build"], "Build prerequisite");
}

const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: rootDir,
  encoding: "utf8",
});

if (packed.status !== 0) {
  throw new Error(`npm pack --dry-run failed: ${packed.stderr}`);
}

const [packResult] = JSON.parse(packed.stdout) as Array<{
  files: Array<{
    path: string;
  }>;
}>;

const packagedFiles = new Set(packResult.files.map((file) => file.path));
for (const requiredFile of ["dist/index.js", "dist/index.d.ts", "package.json"]) {
  if (!packagedFiles.has(requiredFile)) {
    throw new Error(`Expected ${requiredFile} to be included in the published package.`);
  }
}

const builtPlugin = (await import(pathToFileURL(distIndexPath).href)) as {
  OpenCodeOpenAICompatPlugin?: unknown;
  DEFAULT_PLUGIN_CONFIG?: Record<string, unknown>;
};

if (typeof builtPlugin.OpenCodeOpenAICompatPlugin !== "function") {
  throw new Error("Built package is missing the OpenCodeOpenAICompatPlugin export.");
}

if (builtPlugin.DEFAULT_PLUGIN_CONFIG?.host !== "127.0.0.1") {
  throw new Error("Built package is missing the declared default host configuration.");
}

if (builtPlugin.DEFAULT_PLUGIN_CONFIG?.port !== 4097) {
  throw new Error("Built package is missing the declared default port configuration.");
}

console.log("Real packaging smoke test passed.");
