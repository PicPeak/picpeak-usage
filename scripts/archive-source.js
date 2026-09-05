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
  "public/fonts.css",
  "public/fonts",
  "public/picpeak-mark.svg",
  "public/favicon.ico",
  "protocol",
  "server",
  "web",
  "test",
  "docs",
  "scripts",
];
execFileSync(
  "tar",
  ["-czf", path.join(root, "public/source.tar.gz"), ...files],
  { cwd: root },
);
