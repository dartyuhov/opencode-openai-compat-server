import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackageJson = {
  name?: string;
  version?: string;
  type?: string;
  main?: string;
  types?: string;
  exports?: Record<string, { import?: string; types?: string }>;
  files?: string[];
  scripts?: Record<string, string>;
};

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = path.join(rootDir, "package.json");
const entryPointPath = path.join(rootDir, "src", "index.ts");

const normalizePath = (value: string | undefined) => value?.replace(/^\.\//, "");

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
const failures: string[] = [];

if (!existsSync(entryPointPath)) {
  failures.push("Missing src/index.ts. Create the plugin entrypoint that OpenCode loads from the package export map.");
}

if (!packageJson.name) {
  failures.push("package.json is missing `name`. Set the npm package name users will install through OpenCode.");
}

if (!packageJson.version) {
  failures.push("package.json is missing `version`. Published OpenCode plugins need a versioned npm package.");
}

if (packageJson.type !== "module") {
  failures.push("package.json `type` must be `module` so the plugin is published as ESM.");
}

if (normalizePath(packageJson.main) !== "dist/index.js") {
  failures.push("package.json `main` must point to ./dist/index.js.");
}

if (normalizePath(packageJson.types) !== "dist/index.d.ts") {
  failures.push("package.json `types` must point to ./dist/index.d.ts.");
}

const rootExport = packageJson.exports?.["."];
if (!rootExport) {
  failures.push("package.json must declare exports['.'] so OpenCode can resolve the npm plugin entrypoint.");
} else {
  if (normalizePath(rootExport.import) !== "dist/index.js") {
    failures.push("package.json exports['.'].import must point to ./dist/index.js.");
  }

  if (normalizePath(rootExport.types) !== "dist/index.d.ts") {
    failures.push("package.json exports['.'].types must point to ./dist/index.d.ts.");
  }
}

if (!packageJson.files?.includes("dist")) {
  failures.push("package.json must include `files: [\"dist\"]` so npm publishes the built plugin artifact.");
}

for (const scriptName of ["build", "test", "typecheck", "test:e2e:real"]) {
  if (!packageJson.scripts?.[scriptName]) {
    failures.push(`package.json is missing the \`${scriptName}\` script required by this scaffold.`);
  }
}

if (failures.length > 0) {
  console.error("Plugin packaging validation failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Plugin packaging validation passed.");
