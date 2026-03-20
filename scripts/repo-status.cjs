const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const repoRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(repoRoot, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

const IGNORED_NAMES = new Set([".git", "node_modules", ".next"]);

function listRelativeFiles(directory) {
  const absoluteDirectory = path.join(repoRoot, directory);

  if (!fs.existsSync(absoluteDirectory)) {
    return [];
  }

  return walkDirectory(absoluteDirectory)
    .map((filePath) => path.relative(repoRoot, filePath).split(path.sep).join("/"))
    .sort((left, right) => left.localeCompare(right));
}

function walkDirectory(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkDirectory(absolutePath));
      continue;
    }

    files.push(absolutePath);
  }

  return files;
}

function countFilesByExtension(files) {
  const counts = {};

  for (const filePath of files) {
    const extension = path.extname(filePath) || "<no extension>";
    counts[extension] = (counts[extension] || 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  );
}

function getEnvironmentVariables() {
  const envExamplePath = path.join(repoRoot, ".env.example");

  if (!fs.existsSync(envExamplePath)) {
    return [];
  }

  return fs
    .readFileSync(envExamplePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => line.split("=", 1)[0]);
}

function getGitDetails() {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["status", "--short"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .trim()
      .length > 0;

    return {
      branch,
      commit,
      workingTree: dirty ? "dirty" : "clean",
    };
  } catch (error) {
    return {
      branch: "unknown",
      commit: "unknown",
      workingTree: "unknown",
    };
  }
}

function getTopLevelEntries() {
  return fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => !IGNORED_NAMES.has(entry.name))
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort((left, right) => left.localeCompare(right));
}

function detectFramework() {
  if (packageJson.dependencies?.next) {
    return "Next.js App Router";
  }

  return "Unknown";
}

const allFiles = walkDirectory(repoRoot).map((filePath) =>
  path.relative(repoRoot, filePath).split(path.sep).join("/")
);

const report = {
  generatedAt: new Date().toISOString(),
  repoRoot,
  git: getGitDetails(),
  project: {
    name: packageJson.name,
    version: packageJson.version,
    private: packageJson.private === true,
    framework: detectFramework(),
  },
  scripts: packageJson.scripts || {},
  checks: {
    hasDevScript: Boolean(packageJson.scripts?.dev),
    hasBuildScript: Boolean(packageJson.scripts?.build),
    hasStartScript: Boolean(packageJson.scripts?.start),
    hasLintScript: Boolean(packageJson.scripts?.lint),
    hasTestScript: Boolean(packageJson.scripts?.test),
    hasEnvExample: fs.existsSync(path.join(repoRoot, ".env.example")),
  },
  topLevelEntries: getTopLevelEntries(),
  routes: {
    pages: listRelativeFiles("app").filter((filePath) => /\/page\.(js|jsx|ts|tsx)$/.test(`/${filePath}`)),
    api: listRelativeFiles("app/api").filter((filePath) => /\/route\.(js|jsx|ts|tsx)$/.test(`/${filePath}`)),
  },
  components: listRelativeFiles("app/components"),
  libraries: listRelativeFiles("lib"),
  environmentVariables: getEnvironmentVariables(),
  dependencies: {
    production: Object.keys(packageJson.dependencies || {}).sort(),
    development: Object.keys(packageJson.devDependencies || {}).sort(),
  },
  inventory: {
    totalFiles: allFiles.length,
    filesByExtension: countFilesByExtension(allFiles),
  },
};

report.findings = [
  report.checks.hasLintScript ? null : "No lint script configured.",
  report.checks.hasTestScript ? null : "No test script configured.",
].filter(Boolean);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log("Repository status");
console.log("=================");
console.log(`Generated: ${report.generatedAt}`);
console.log(`Root: ${report.repoRoot}`);
console.log(`Git: ${report.git.branch} @ ${report.git.commit} (${report.git.workingTree})`);
console.log(`Project: ${report.project.name}@${report.project.version}`);
console.log(`Framework: ${report.project.framework}`);
console.log("");
console.log("Scripts:");
for (const [name, command] of Object.entries(report.scripts)) {
  console.log(`- ${name}: ${command}`);
}
console.log("");
console.log("Checks:");
console.log(`- build script: ${report.checks.hasBuildScript ? "yes" : "no"}`);
console.log(`- dev script: ${report.checks.hasDevScript ? "yes" : "no"}`);
console.log(`- start script: ${report.checks.hasStartScript ? "yes" : "no"}`);
console.log(`- lint script: ${report.checks.hasLintScript ? "yes" : "no"}`);
console.log(`- test script: ${report.checks.hasTestScript ? "yes" : "no"}`);
console.log(`- .env.example: ${report.checks.hasEnvExample ? "yes" : "no"}`);
console.log("");
console.log("Top-level entries:");
for (const entry of report.topLevelEntries) {
  console.log(`- ${entry}`);
}
console.log("");
console.log("App pages:");
for (const page of report.routes.pages) {
  console.log(`- ${page}`);
}
console.log("");
console.log("API routes:");
for (const route of report.routes.api) {
  console.log(`- ${route}`);
}
console.log("");
console.log("Components:");
for (const component of report.components) {
  console.log(`- ${component}`);
}
console.log("");
console.log("Libraries:");
for (const library of report.libraries) {
  console.log(`- ${library}`);
}
console.log("");
console.log("Environment variables:");
for (const variable of report.environmentVariables) {
  console.log(`- ${variable}`);
}
console.log("");
console.log("Dependencies:");
console.log(`- production (${report.dependencies.production.length}): ${report.dependencies.production.join(", ")}`);
console.log(`- development (${report.dependencies.development.length}): ${report.dependencies.development.join(", ")}`);
console.log("");
console.log("Inventory:");
console.log(`- total files: ${report.inventory.totalFiles}`);
for (const [extension, count] of Object.entries(report.inventory.filesByExtension)) {
  console.log(`- ${extension}: ${count}`);
}
console.log("");
console.log("Findings:");
for (const finding of report.findings) {
  console.log(`- ${finding}`);
}
