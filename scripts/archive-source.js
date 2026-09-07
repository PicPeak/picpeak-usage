const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
fs.mkdirSync(path.join(root, "public"), { recursive: true });
// Fixed allowlist. Never package credentials, storage, Git, or agent files.
const files = [
  ".gitignore",
  ".dockerignore",
  ".env.example",
  "README.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  "Dockerfile",
  "compose.yaml",
  "index.html",
  "tsconfig.json",
  "vite.config.mjs",
  "playwright.config.ts",
  ".github",
  "public/fonts.css",
  "public/fonts",
  "public/picpeak-mark.svg",
  "public/favicon.ico",
  "protocol",
  "server",
  "web",
  "test",
  "docs/DESIGN.md",
  "docs/FEATURE_COVERAGE.md",
  "docs/OPERATIONS.md",
  "docs/PROTOCOL.md",
  "docs/usage-coverage.v2.json",
  "docs/usage-coverage.v3.json",
  "docs/usage-coverage.v4.json",
  "docs/usage-coverage.v5.json",
  "scripts",
];
// Builds run outside Git too (Docker and downloaded source archives). Do not
// recursively include ignored local files just because their parent is source.
const localNames = new Set([
  "node_modules", ".git", ".local", ".cache", ".vite", ".nyc_output",
  ".vscode", ".idea", ".claude", ".codex", ".cursor", ".playwright-mcp",
  "test-results", "playwright-report", "blob-report",
  "AGENTS.md", "CLAUDE.md", "GEMINI.md", "WORKSPACE.md", ".DS_Store", "Thumbs.db",
]);
function sourceFiles(relative) {
  const name = path.basename(relative);
  if (localNames.has(name) ||
      ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example") ||
      /\.(?:log|sqlite(?:-.*)?|tsbuildinfo|swp|swo|tmp|temp|orig|rej)$/.test(name))
    return [];
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  // Local symlinks can point outside the source checkout.
  if (stat.isSymbolicLink()) return [];
  if (stat.isDirectory())
    return fs.readdirSync(absolute).sort().flatMap((child) => sourceFiles(path.join(relative, child)));
  return stat.isFile() ? [relative] : [];
}
execFileSync(
  "tar",
  ["-czf", path.join(root, "public/source.tar.gz"), ...files.flatMap(sourceFiles)],
  { cwd: root },
);
