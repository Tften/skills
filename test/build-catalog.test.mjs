import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildCatalog } from "../scripts/build-catalog.mjs";

const cliPath = fileURLToPath(new URL("../scripts/build-catalog.mjs", import.meta.url));

function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeSkill(root, relativeDir, options = {}) {
  const { name = basename(relativeDir), skillMd, files = {} } = options;
  const skillDir = join(root, relativeDir);
  mkdirSync(skillDir, { recursive: true });

  if (skillMd !== null) {
    const content =
      skillMd ??
      `---\nname: ${name}\ndescription: Fixture skill used by the catalog builder tests.\n---\n\n# ${name}\n`;
    writeFileSync(join(skillDir, "SKILL.md"), content);
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(skillDir, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }

  return skillDir;
}

function writeManifest(root, entries) {
  const manifestDir = join(root, ".claude-plugin");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(
    join(manifestDir, "plugin.json"),
    JSON.stringify({ name: "fixture-skills", skills: entries }, null, 2),
  );
}

function standardRepo(t) {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/alpha", {
    files: {
      "notes.md": "alpha notes\n",
      "agents/openai.yaml": "name: alpha\n",
      ".hidden": "must be skipped\n",
      ".cache/data.bin": Buffer.from([0, 1, 2, 3]),
    },
  });
  writeSkill(root, "skills/beta", {
    files: {
      "reference/guide.md": "beta guide\n",
      "agents/openai.yaml": "name: beta\n",
    },
  });
  writeSkill(root, "skills/not-promoted");
  writeManifest(root, ["./skills/beta", "./skills/alpha"]);
  return root;
}

function listFiles(root) {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  };
  walk(root, "");
  return files.sort();
}

function readIndex(outDir) {
  return JSON.parse(readFileSync(join(outDir, "index.json"), "utf8"));
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    ...options,
  });
}

test("packages only manifest-listed skills, in manifest order", (t) => {
  const root = standardRepo(t);
  const outDir = tempDir(t, "catalog-out-");

  const index = buildCatalog({ repoRoot: root, outDir });

  assert.deepEqual(
    index.skills.map((skill) => skill.name),
    ["beta", "alpha"],
  );
  assert.deepEqual(
    readIndex(outDir).skills.map((skill) => skill.name),
    ["beta", "alpha"],
  );
  assert.deepEqual(readdirSync(outDir).sort(), ["alpha", "beta", "index.json"]);
  assert.ok(existsSync(join(outDir, "beta", "SKILL.md")));
  assert.ok(existsSync(join(outDir, "alpha", "SKILL.md")));
  assert.equal(existsSync(join(outDir, "not-promoted")), false);
});

test("copies packaged files byte-for-byte and skips hidden entries", (t) => {
  const root = standardRepo(t);
  const outDir = tempDir(t, "catalog-out-");

  const index = buildCatalog({ repoRoot: root, outDir });
  const alpha = index.skills.find((skill) => skill.name === "alpha");

  assert.deepEqual(alpha.files, ["SKILL.md", "agents/openai.yaml", "notes.md"]);
  for (const relativePath of alpha.files) {
    assert.deepEqual(
      readFileSync(join(outDir, "alpha", relativePath)),
      readFileSync(join(root, "skills/alpha", relativePath)),
    );
  }
  assert.equal(existsSync(join(outDir, "alpha", ".hidden")), false);
  assert.equal(existsSync(join(outDir, "alpha", ".cache")), false);
});

test("index files list exactly the files present on disk", (t) => {
  const root = standardRepo(t);
  const outDir = tempDir(t, "catalog-out-");

  const index = buildCatalog({ repoRoot: root, outDir });

  assert.deepEqual(
    readdirSync(outDir).sort(),
    ["alpha", "beta", "index.json"].sort(),
  );
  for (const skill of index.skills) {
    assert.deepEqual(listFiles(join(outDir, skill.name)), skill.files);
  }
});

test("buildCatalog returns the index it writes", (t) => {
  const root = standardRepo(t);
  const outDir = tempDir(t, "catalog-out-");

  const returned = buildCatalog({ repoRoot: root, outDir });

  assert.deepEqual(returned, readIndex(outDir));
  for (const skill of returned.skills) {
    assert.match(skill.version, /^[0-9a-f]{64}$/);
  }
});

function singleSkillRepo(t) {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/solo", {
    files: {
      "notes.md": "solo notes\n",
      "agents/openai.yaml": "name: solo\n",
    },
  });
  writeManifest(root, ["./skills/solo"]);
  return root;
}

function versionOf(index, name = "solo") {
  return index.skills.find((skill) => skill.name === name).version;
}

test("identical input produces identical versions and output", (t) => {
  const root = standardRepo(t);
  const firstOut = tempDir(t, "catalog-out-");
  const secondOut = tempDir(t, "catalog-out-");

  const first = buildCatalog({ repoRoot: root, outDir: firstOut });
  const second = buildCatalog({ repoRoot: root, outDir: secondOut });

  assert.deepEqual(first, second);
  for (const skill of first.skills) {
    assert.deepEqual(listFiles(join(secondOut, skill.name)), listFiles(join(firstOut, skill.name)));
    for (const relativePath of skill.files) {
      assert.deepEqual(
        readFileSync(join(secondOut, skill.name, relativePath)),
        readFileSync(join(firstOut, skill.name, relativePath)),
      );
    }
  }
});

test("changing SKILL.md changes the version", (t) => {
  const root = singleSkillRepo(t);
  const outDir = tempDir(t, "catalog-out-");
  const before = versionOf(buildCatalog({ repoRoot: root, outDir }));

  writeFileSync(join(root, "skills/solo/SKILL.md"), "---\nname: solo\n---\n\nChanged.\n");
  const after = versionOf(buildCatalog({ repoRoot: root, outDir }));

  assert.notEqual(after, before);
});

test("changing a supporting file changes the version", (t) => {
  const root = singleSkillRepo(t);
  const outDir = tempDir(t, "catalog-out-");
  const before = versionOf(buildCatalog({ repoRoot: root, outDir }));

  writeFileSync(join(root, "skills/solo/notes.md"), "solo notes, revised\n");
  const after = versionOf(buildCatalog({ repoRoot: root, outDir }));

  assert.notEqual(after, before);
});

test("adding a file changes the version", (t) => {
  const root = singleSkillRepo(t);
  const outDir = tempDir(t, "catalog-out-");
  const before = versionOf(buildCatalog({ repoRoot: root, outDir }));

  writeFileSync(join(root, "skills/solo/extra.md"), "extra\n");
  const after = versionOf(buildCatalog({ repoRoot: root, outDir }));

  assert.notEqual(after, before);
});

test("renaming a file changes the version", (t) => {
  const root = singleSkillRepo(t);
  const outDir = tempDir(t, "catalog-out-");
  const before = versionOf(buildCatalog({ repoRoot: root, outDir }));

  writeFileSync(join(root, "skills/solo/renamed.md"), readFileSync(join(root, "skills/solo/notes.md")));
  rmSync(join(root, "skills/solo/notes.md"));
  const after = versionOf(buildCatalog({ repoRoot: root, outDir }));

  assert.notEqual(after, before);
});

test("timestamps do not change the version", (t) => {
  const root = singleSkillRepo(t);
  const outDir = tempDir(t, "catalog-out-");
  const before = versionOf(buildCatalog({ repoRoot: root, outDir }));

  const future = new Date("2035-01-02T03:04:05Z");
  utimesSync(join(root, "skills/solo/SKILL.md"), future, future);
  utimesSync(join(root, "skills/solo/notes.md"), future, future);
  const after = versionOf(buildCatalog({ repoRoot: root, outDir }));

  assert.equal(after, before);
});

test("a rebuild removes stale output", (t) => {
  const root = singleSkillRepo(t);
  const outDir = tempDir(t, "catalog-out-");

  buildCatalog({ repoRoot: root, outDir });
  writeFileSync(join(outDir, "stale.txt"), "left over from an older build\n");
  mkdirSync(join(outDir, "retired-skill"), { recursive: true });
  writeFileSync(join(outDir, "retired-skill", "SKILL.md"), "# Retired\n");

  buildCatalog({ repoRoot: root, outDir });

  assert.equal(existsSync(join(outDir, "stale.txt")), false);
  assert.equal(existsSync(join(outDir, "retired-skill")), false);
});

function assertBuildFails(t, root, pattern) {
  const outDir = tempDir(t, "catalog-out-");
  assert.throws(() => buildCatalog({ repoRoot: root, outDir }), pattern);
  return outDir;
}

test("fails when the plugin manifest is missing", (t) => {
  const root = tempDir(t, "catalog-repo-");

  assertBuildFails(t, root, /plugin\.json/);
});

test("fails when the plugin manifest is not valid JSON", (t) => {
  const root = tempDir(t, "catalog-repo-");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), "{ not json");

  assertBuildFails(t, root, /not valid JSON/);
});

test("fails when the plugin manifest has no skills array", (t) => {
  const root = tempDir(t, "catalog-repo-");
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "fixture" }));

  assertBuildFails(t, root, /"skills" array/);
});

test("fails when a manifest entry escapes the repository root", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeManifest(root, ["../outside"]);

  assertBuildFails(t, root, /outside the repository root/);
});

test("fails when a skill directory does not exist", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeManifest(root, ["./skills/missing"]);

  assertBuildFails(t, root, /does not exist/);
});

test("fails when a skill has no SKILL.md", (t) => {
  const root = tempDir(t, "catalog-repo-");
  mkdirSync(join(root, "skills/no-skill"), { recursive: true });
  writeFileSync(join(root, "skills/no-skill/notes.md"), "notes\n");
  writeManifest(root, ["./skills/no-skill"]);

  assertBuildFails(t, root, /missing SKILL\.md/);
});

test("fails when a skill directory is empty", (t) => {
  const root = tempDir(t, "catalog-repo-");
  mkdirSync(join(root, "skills/empty"), { recursive: true });
  writeManifest(root, ["./skills/empty"]);

  assertBuildFails(t, root, /missing SKILL\.md/);
});

test("fails when the frontmatter name does not match the directory name", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/alpha", { name: "some-other-name" });
  writeManifest(root, ["./skills/alpha"]);

  assertBuildFails(t, root, /does not match/);
});

test("fails on duplicate skill IDs", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/one/gamma");
  writeSkill(root, "skills/two/gamma");
  writeManifest(root, ["./skills/one/gamma", "./skills/two/gamma"]);

  assertBuildFails(t, root, /Duplicate skill ID "gamma"/);
});

test("fails on unsafe skill IDs", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/bad#name");
  writeManifest(root, ["./skills/bad#name"]);

  assertBuildFails(t, root, /unsafe skill ID/i);
});

test("fails on unsafe packaged file paths", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/solo", { files: { "bad#name.md": "unsafe\n" } });
  writeManifest(root, ["./skills/solo"]);

  assertBuildFails(t, root, /unsafe file path/i);
});

test("fails on symbolic links", (t) => {
  const root = tempDir(t, "catalog-repo-");
  const outside = tempDir(t, "catalog-outside-");
  writeFileSync(join(outside, "secret.md"), "secret\n");
  writeSkill(root, "skills/solo");
  try {
    symlinkSync(outside, join(root, "skills/solo/linked"), process.platform === "win32" ? "junction" : "dir");
  } catch {
    t.skip("symbolic links are not supported in this environment");
    return;
  }
  writeManifest(root, ["./skills/solo"]);

  assertBuildFails(t, root, /symbolic link/i);
});

test("a failed build leaves the previous output untouched", (t) => {
  const root = singleSkillRepo(t);
  const outDir = tempDir(t, "catalog-out-");
  buildCatalog({ repoRoot: root, outDir });
  writeFileSync(join(outDir, "keep.txt"), "previous build\n");

  rmSync(join(root, "skills/solo/SKILL.md"));
  assert.throws(() => buildCatalog({ repoRoot: root, outDir }), /missing SKILL\.md/);

  assert.equal(readFileSync(join(outDir, "keep.txt"), "utf8"), "previous build\n");
});

test("defaults the output directory to <root>/dist/catalog", (t) => {
  const root = singleSkillRepo(t);

  buildCatalog({ repoRoot: root });

  assert.deepEqual(
    readIndex(join(root, "dist", "catalog")).skills.map((skill) => skill.name),
    ["solo"],
  );
});

test("refuses an output directory that would remove the repository", (t) => {
  const root = singleSkillRepo(t);

  assert.throws(
    () => buildCatalog({ repoRoot: root, outDir: root }),
    /would remove or overwrite the repository/,
  );
  assert.ok(existsSync(join(root, "skills/solo/SKILL.md")));
});

test("refuses an output directory that overlaps a skill source", (t) => {
  const root = singleSkillRepo(t);
  const outDir = join(root, "skills/solo/dist");

  assert.throws(
    () => buildCatalog({ repoRoot: root, outDir }),
    /overlaps the catalog source/,
  );
  assert.ok(existsSync(join(root, "skills/solo/SKILL.md")));
});

test("fails when the repository root does not exist", (t) => {
  const root = tempDir(t, "catalog-repo-");
  const outDir = tempDir(t, "catalog-out-");

  assert.throws(
    () => buildCatalog({ repoRoot: join(root, "missing"), outDir }),
    /does not exist or cannot be read/,
  );
});

test("fails when a manifest entry is not a string", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeManifest(root, [42]);

  assertBuildFails(t, root, /must be a non-empty string/);
});

test("fails on uppercase skill IDs", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/Uppercase");
  writeManifest(root, ["./skills/Uppercase"]);

  assertBuildFails(t, root, /lowercase kebab-case/);
});

test("fails on percent-encoded traversal in packaged file paths", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/solo", { files: { "%2e%2e/secret.md": "secret\n" } });
  writeManifest(root, ["./skills/solo"]);

  assertBuildFails(t, root, /unsafe file path/i);
});

test("fails on percent-encoded separators in packaged file paths", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/solo", { files: { "%2fescape.md": "secret\n" } });
  writeManifest(root, ["./skills/solo"]);

  assertBuildFails(t, root, /unsafe file path/i);
});

test("fails when SKILL.md has no frontmatter", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/solo", { skillMd: "# No frontmatter\n" });
  writeManifest(root, ["./skills/solo"]);

  assertBuildFails(t, root, /must start with YAML frontmatter/);
});

test("fails when SKILL.md has unclosed frontmatter", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/solo", { skillMd: "---\nname: solo\n" });
  writeManifest(root, ["./skills/solo"]);

  assertBuildFails(t, root, /unclosed YAML frontmatter/);
});

test("fails when SKILL.md does not declare a name", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/solo", { skillMd: "---\ndescription: no name\n---\n" });
  writeManifest(root, ["./skills/solo"]);

  assertBuildFails(t, root, /must declare frontmatter "name:/);
});

test("accepts a quoted frontmatter name", (t) => {
  const root = tempDir(t, "catalog-repo-");
  writeSkill(root, "skills/solo", { skillMd: '---\nname: "solo"\n---\n\n# Solo\n' });
  writeManifest(root, ["./skills/solo"]);
  const outDir = tempDir(t, "catalog-out-");

  const index = buildCatalog({ repoRoot: root, outDir });

  assert.deepEqual(index.skills.map((skill) => skill.name), ["solo"]);
});

test("CLI builds a catalog from --root and --out", (t) => {
  const root = singleSkillRepo(t);
  const outDir = tempDir(t, "catalog-out-");

  const result = runCli(["--root", root, "--out", outDir]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Built catalog with 1 skill/);
  assert.deepEqual(
    readIndex(outDir).skills.map((skill) => skill.name),
    ["solo"],
  );
});

test("CLI supports --root=value and --out=value", (t) => {
  const root = singleSkillRepo(t);
  const outDir = tempDir(t, "catalog-out-");

  const result = runCli([`--root=${root}`, `--out=${outDir}`]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(outDir, "index.json")));
});

test("CLI --help prints usage and exits zero", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node scripts\/build-catalog\.mjs/);
  assert.match(result.stdout, /--root <dir>/);
});

test("CLI exits non-zero on a validation failure", (t) => {
  const root = tempDir(t, "catalog-repo-");
  const outDir = tempDir(t, "catalog-out-");

  const result = runCli(["--root", root, "--out", outDir]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^build-catalog: /);
  assert.equal(existsSync(join(outDir, "index.json")), false);
});

test("CLI rejects unknown arguments", () => {
  const result = runCli(["--wat"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown argument "--wat"/);
});
