#!/usr/bin/env node
// Builds the OpenCode HTTP catalog from the skills promoted in the Claude Code plugin manifest.
// Usage: node scripts/build-catalog.mjs [--root <dir>] [--out <dir>] [--help]

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST_SEGMENTS = [".claude-plugin", "plugin.json"];

const USAGE = `Usage: node scripts/build-catalog.mjs [options]

Builds the OpenCode HTTP catalog from the skills listed in the Claude Code
plugin manifest.

Options:
  --root <dir>  Repository root (default: current directory)
  --out <dir>   Output directory, relative to the current directory
                (default: <root>/dist/catalog)
  --help, -h    Show this help message`;

class CatalogError extends Error {}

const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function fail(message) {
  throw new CatalogError(message);
}

function isSameOrInside(parent, child) {
  const relativePath = relative(parent, child);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function assertSafeSkillId(name, entry, manifestPath) {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.includes("?") ||
    name.includes("#") ||
    isAbsolute(name) ||
    URL_LIKE.test(name)
  ) {
    fail(
      `The manifest entry "${entry}" in ${manifestPath} has an unsafe skill ID "${name}". Skill IDs must be a single path segment with no "/", "\\", "?", "#", or URL syntax.`,
    );
  }
}

function isSafeSegment(segment) {
  if (segment === "" || segment === "." || segment === "..") {
    return false;
  }
  try {
    const decoded = decodeURIComponent(segment);
    return (
      decoded !== "" &&
      decoded !== "." &&
      decoded !== ".." &&
      !decoded.includes("/") &&
      !decoded.includes("\\") &&
      !decoded.includes("\0")
    );
  } catch {
    return false;
  }
}

function assertSafeFilePath(relativePath, skillName) {
  const segments = relativePath.split("/");
  if (
    relativePath === "" ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.includes("?") ||
    relativePath.includes("#") ||
    isAbsolute(relativePath) ||
    URL.canParse(relativePath) ||
    URL_LIKE.test(relativePath) ||
    segments.some((segment) => !isSafeSegment(segment))
  ) {
    fail(
      `Skill "${skillName}" contains an unsafe file path "${relativePath}". File paths must be relative with POSIX separators and must not contain "\\", "?", "#", URL syntax, or "." and ".." segments.`,
    );
  }
}

function validateFrontmatterName(skillDir, skillName) {
  const skillMdPath = join(skillDir, "SKILL.md");
  const lines = readFileSync(skillMdPath, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);

  if (lines[0] !== "---") {
    fail(`SKILL.md for skill "${skillName}" must start with YAML frontmatter delimited by "---".`);
  }

  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index] === "---") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    fail(`SKILL.md for skill "${skillName}" has unclosed YAML frontmatter.`);
  }

  const nameLine = lines.slice(1, closingIndex).find((line) => /^name\s*:/.test(line));
  if (!nameLine) {
    fail(
      `SKILL.md for skill "${skillName}" must declare frontmatter "name: ${skillName}".`,
    );
  }

  let declaredName = nameLine.replace(/^name\s*:\s*/, "").trim();
  if (
    (declaredName.startsWith('"') && declaredName.endsWith('"')) ||
    (declaredName.startsWith("'") && declaredName.endsWith("'"))
  ) {
    declaredName = declaredName.slice(1, -1);
  }

  if (declaredName !== skillName) {
    fail(
      `SKILL.md for skill "${skillName}" declares frontmatter name "${declaredName}", which does not match the directory name.`,
    );
  }
}

function readManifest(repoRoot) {
  const manifestPath = join(repoRoot, ...MANIFEST_SEGMENTS);
  let source;

  try {
    source = readFileSync(manifestPath, "utf8");
  } catch (error) {
    fail(`Could not read the plugin manifest at ${manifestPath}: ${error.message}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    fail(`The plugin manifest at ${manifestPath} is not valid JSON: ${error.message}`);
  }

  if (
    manifest === null ||
    typeof manifest !== "object" ||
    !Array.isArray(manifest.skills)
  ) {
    fail(`The plugin manifest at ${manifestPath} must contain a "skills" array.`);
  }

  return { manifestPath, entries: manifest.skills };
}

function resolveSkillDirectory(repoRoot, entry, manifestPath) {
  if (typeof entry !== "string" || entry.trim() === "") {
    fail(`Every "skills" entry in ${manifestPath} must be a non-empty string.`);
  }

  const absolutePath = resolve(repoRoot, entry);
  const relativePath = relative(repoRoot, absolutePath);

  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    fail(
      `The manifest entry "${entry}" in ${manifestPath} points outside the repository root.`,
    );
  }

  return absolutePath;
}

function collectFiles(skillDir, skillName) {
  const files = [];

  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const stats = lstatSync(absolutePath);

      if (stats.isSymbolicLink()) {
        fail(
          `Skill "${skillName}" contains a symbolic link at "${relativePath}". Symbolic links are not allowed in the catalog.`,
        );
      }

      if (stats.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }

      if (!stats.isFile()) {
        fail(
          `Skill "${skillName}" contains a non-regular file at "${relativePath}". Only ordinary files are allowed.`,
        );
      }

      assertSafeFilePath(relativePath, skillName);
      files.push({ path: relativePath, absolutePath, bytes: readFileSync(absolutePath) });
    }
  };

  walk(skillDir, "");
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

function computeVersion(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function loadSkill(repoRoot, realRepoRoot, entry, manifestPath) {
  const skillDir = resolveSkillDirectory(repoRoot, entry, manifestPath);

  let stats;
  try {
    stats = lstatSync(skillDir);
  } catch (error) {
    fail(`The skill directory for manifest entry "${entry}" does not exist: ${skillDir}`);
  }

  if (stats.isSymbolicLink()) {
    fail(
      `The skill directory for manifest entry "${entry}" is a symbolic link. Symbolic links are not allowed in the catalog.`,
    );
  }

  if (!stats.isDirectory()) {
    fail(`The manifest entry "${entry}" is not a directory: ${skillDir}`);
  }

  const realSkillDir = realpathSync(skillDir);
  const realRelativePath = relative(realRepoRoot, realSkillDir);
  if (
    realRelativePath === "" ||
    realRelativePath === ".." ||
    realRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(realRelativePath)
  ) {
    fail(
      `The manifest entry "${entry}" resolves outside the repository root: ${realSkillDir}`,
    );
  }

  const name = basename(skillDir);
  assertSafeSkillId(name, entry, manifestPath);
  const files = collectFiles(skillDir, name);

  if (files.length === 0) {
    fail(`The skill "${name}" is missing SKILL.md at ${join(skillDir, "SKILL.md")}.`);
  }

  if (!files.some((file) => file.path === "SKILL.md")) {
    fail(`The skill "${name}" is missing SKILL.md at ${join(skillDir, "SKILL.md")}.`);
  }

  validateFrontmatterName(skillDir, name);

  return { name, directory: skillDir, files, version: computeVersion(files) };
}

function assertSafeOutput(repoRoot, realRepoRoot, outDir, sources) {
  if (isSameOrInside(outDir, realRepoRoot)) {
    fail(
      `The output directory ${outDir} would remove or overwrite the repository. Choose a dedicated output directory such as ${join(repoRoot, "dist", "catalog")}.`,
    );
  }

  const relativeOutput = relative(realRepoRoot, outDir);
  if (
    relativeOutput !== "" &&
    relativeOutput !== ".." &&
    !relativeOutput.startsWith(`..${sep}`) &&
    !isAbsolute(relativeOutput) &&
    relativeOutput.split(sep)[0] === ".git"
  ) {
    fail(`The output directory ${outDir} must not be inside the .git directory.`);
  }

  for (const source of sources) {
    if (isSameOrInside(outDir, source) || isSameOrInside(source, outDir)) {
      fail(
        `The output directory ${outDir} overlaps the catalog source ${source}. Choose a dedicated output directory.`,
      );
    }
  }
}

export function buildCatalog({ repoRoot = process.cwd(), outDir } = {}) {
  const root = resolve(repoRoot);
  let realRepoRoot;
  try {
    realRepoRoot = realpathSync(root);
  } catch (error) {
    fail(`The repository root ${root} does not exist or cannot be read: ${error.message}`);
  }

  const output = resolve(outDir ?? join(root, "dist", "catalog"));
  const { manifestPath, entries } = readManifest(root);

  const skills = [];
  const seenNames = new Set();
  for (const entry of entries) {
    const skill = loadSkill(root, realRepoRoot, entry, manifestPath);
    if (seenNames.has(skill.name)) {
      fail(`Duplicate skill ID "${skill.name}" in ${manifestPath}. Skill IDs must be unique.`);
    }
    seenNames.add(skill.name);
    skills.push(skill);
  }

  assertSafeOutput(root, realRepoRoot, output, [
    manifestPath,
    ...skills.map((skill) => skill.directory),
  ]);

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  const index = { skills: [] };
  for (const skill of skills) {
    for (const file of skill.files) {
      const destination = join(output, skill.name, ...file.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.bytes);
    }
    index.skills.push({
      name: skill.name,
      version: skill.version,
      files: skill.files.map((file) => file.path),
    });
  }

  writeFileSync(join(output, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    const match = /^--(root|out)(?:=(.*))?$/.exec(argument);
    if (!match) {
      fail(`Unknown argument "${argument}". Run with --help for usage.`);
    }

    const name = match[1];
    let value = match[2];
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      fail(`--${name} requires a directory path.`);
    }
    if (options[name] !== undefined) {
      fail(`--${name} was provided more than once.`);
    }
    options[name] = value;
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(USAGE);
      return 0;
    }

    const repoRoot = options.root ? resolve(options.root) : process.cwd();
    const outDir = options.out ? resolve(options.out) : undefined;
    const index = buildCatalog({ repoRoot, outDir });
    console.log(`Built catalog with ${index.skills.length} skills.`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`build-catalog: ${message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
