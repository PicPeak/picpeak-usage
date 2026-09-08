const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

test("downloadable source excludes nested runtime data and rebuilds without Git", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "usage-archive-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.resolve(__dirname, ".."), fixture = path.join(temp, "source");
  const excluded = new Set([".git", "node_modules", "dist", "storage", "test-results", "playwright-report", "source.tar.gz"]);
  await fs.cp(root, fixture, { recursive: true, filter: source => !path.relative(root, source).split(path.sep).some(part => excluded.has(part)) });
  const marker = "SYNTHETIC_PRIVATE_BUILD_DATA";
  for (const directory of ["server/storage", "web/nested/storage", "scripts/tools/storage", "protocol/storage", "public/fonts/storage", ".github/storage", "test/coverage", "web/dist"]) {
    await fs.mkdir(path.join(fixture, directory), { recursive: true });
    await fs.writeFile(path.join(fixture, directory, "private.json"), marker);
  }
  await fs.writeFile(path.join(temp, "outside-private.json"), marker);
  await fs.symlink(path.join(temp, "outside-private.json"), path.join(fixture, "server/local-secret.json"));
  execFileSync(process.execPath, ["scripts/archive-source.js"], { cwd: fixture });
  const archive = path.join(fixture, "public/source.tar.gz");
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.match(files, /server\/collector\.js/);
  assert.match(files, /scripts\/archive-source\.js/);
  assert.doesNotMatch(files, /(?:^|\/)(?:storage|coverage|dist)\//m);
  assert.doesNotMatch(files, /local-secret\.json|private\.json/);
  const extracted = path.join(temp, "roundtrip");
  await fs.mkdir(extracted);
  execFileSync("tar", ["-xzf", archive, "-C", extracted]);
  execFileSync(process.execPath, ["scripts/archive-source.js"], { cwd: extracted });
  const rebuilt = execFileSync("tar", ["-tzf", path.join(extracted, "public/source.tar.gz")], { encoding: "utf8" });
  assert.equal(rebuilt, files);
});
