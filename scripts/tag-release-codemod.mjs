/**
 * tag-release-codemod.mjs
 *
 * One-shot deterministic codemod: assign an api-extractor release tag to every
 * public export of the SDK that lacks one. The package was never release-tag
 * curated (1143 untagged symbols); this brings the whole surface under explicit
 * tags so `api-extractor run` (ae-missing-release-tag = error) passes, and the
 * error-level gate then prevents any NEW untagged export forever.
 *
 * Policy (truthful defaults for a shipped v3.x OSS SDK):
 *   - name starts with "_"  -> @internal (deliberate private/test helper)
 *   - name ends with "Impl" -> @internal (implementation class leaking to surface)
 *   - declared in a file that already self-marks @alpha/@beta -> inherit @alpha
 *   - everything else exported from index -> @public (supported, semver-governed)
 *
 * Symbols that already carry a release tag are skipped (idempotent). Only JSDoc
 * comments are added; no code is modified. Run: `node scripts/tag-release-codemod.mjs`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(here, "..");
const indexPath = resolve(projectDir, "src/index.ts");
const RELEASE_TAG_RE = /@(public|alpha|beta|internal)\b/;

// ── Load the program from tsconfig ──────────────────────────────────────────
const configPath = resolve(projectDir, "tsconfig.json");
const configJson = ts.readConfigFile(configPath, ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(configJson, ts.sys, projectDir);
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: { ...parsed.options, noEmit: true },
});
const checker = program.getTypeChecker();

const indexSf = program.getSourceFile(indexPath);
if (!indexSf) throw new Error(`cannot load ${indexPath}`);
const indexSymbol = checker.getSymbolAtLocation(indexSf);
if (!indexSymbol) throw new Error("index.ts is not a module symbol");

// Files that already self-declare experimental tags -> their untagged siblings
// inherit @alpha (a module that marks some exports experimental is experimental).
const experimentalFiles = new Set();
for (const sf of program.getSourceFiles()) {
  if (sf.fileName.includes("/node_modules/")) continue;
  if (!sf.fileName.includes("/src/")) continue;
  if (/@alpha\b|@beta\b/.test(sf.text)) experimentalFiles.add(sf.fileName);
}

// ── Resolve the documentable node + its existing JSDoc ──────────────────────
function documentableNode(decl) {
  // A variable's JSDoc lives on the enclosing VariableStatement.
  if (ts.isVariableDeclaration(decl)) {
    let n = decl.parent;
    while (n && !ts.isVariableStatement(n)) n = n.parent;
    return n ?? decl;
  }
  return decl;
}

function hasReleaseTag(node) {
  const jsDocs = ts.getJSDocCommentsAndTags(node);
  for (const d of jsDocs) {
    if (RELEASE_TAG_RE.test(d.getFullText())) return true;
  }
  return false;
}

function chooseTag(name, fileName) {
  if (name.startsWith("_")) return "internal";
  if (name.endsWith("Impl")) return "internal";
  if (experimentalFiles.has(fileName)) return "alpha";
  return "public";
}

// ── Collect edits keyed by file ─────────────────────────────────────────────
/** @type {Map<string, {start:number,end:number,text:string}[]>} */
const editsByFile = new Map();
const seen = new Set(); // dedupe by declaration position

for (const exp of checker.getExportsOfModule(indexSymbol)) {
  let sym = exp;
  if (sym.flags & ts.SymbolFlags.Alias) {
    try {
      sym = checker.getAliasedSymbol(sym);
    } catch {
      /* keep alias symbol */
    }
  }
  const allDecls = sym.getDeclarations?.() ?? [];
  // Tag EVERY src declaration of the symbol. The Zod `const X = z.enum(...)` +
  // `type X = z.infer<typeof X>` merge pattern means one exported name has two
  // declarations; api-extractor wants the release tag visible on each.
  const decls = allDecls.filter(
    (d) =>
      d.getSourceFile().fileName.includes("/src/") && !d.getSourceFile().fileName.endsWith(".d.ts"),
  );
  for (const decl of decls) {
    tagDeclaration(decl, exp.getName());
  }
}

function tagDeclaration(decl, exportName) {
  const sf = decl.getSourceFile();
  if (sf.fileName.includes("/node_modules/")) return;
  if (sf.fileName.endsWith(".d.ts")) return;

  const node = documentableNode(decl);
  const key = `${sf.fileName}:${node.getStart(sf)}`;
  if (seen.has(key)) return;
  seen.add(key);

  if (hasReleaseTag(node)) return;

  const tag = chooseTag(exportName, sf.fileName);
  const text = sf.text;
  const nodeStart = node.getStart(sf);

  // Indentation of the declaration line.
  const lineStart = text.lastIndexOf("\n", nodeStart - 1) + 1;
  const indent = text.slice(lineStart, nodeStart).match(/^[ \t]*/)[0];

  const jsDocs = node.jsDoc; // existing leading JSDoc block(s), if any
  let edit;
  if (jsDocs && jsDocs.length > 0) {
    // Merge the tag into the LAST existing JSDoc block (before its closing */).
    const last = jsDocs[jsDocs.length - 1];
    const jsEnd = last.end;
    const jsStart = text.lastIndexOf("/**", jsEnd);
    const raw = text.slice(jsStart, jsEnd);
    let merged;
    if (raw.includes("\n")) {
      merged = raw.replace(/\n[ \t]*\*\/\s*$/, `\n${indent} * @${tag}\n${indent} */`);
      if (merged === raw) {
        // Fallback if the trailing pattern did not match.
        merged = `${raw.slice(0, -2)}* @${tag}\n${indent} */`;
      }
    } else {
      const inner = raw.slice(3, -2).trim();
      merged = `/**\n${indent} * ${inner}\n${indent} * @${tag}\n${indent} */`;
    }
    edit = { start: jsStart, end: jsEnd, text: merged };
  } else {
    // No JSDoc: add a one-line block above the declaration.
    const block = `/** @${tag} */\n${indent}`;
    edit = { start: nodeStart, end: nodeStart, text: block };
  }

  const arr = editsByFile.get(sf.fileName) ?? [];
  arr.push(edit);
  editsByFile.set(sf.fileName, arr);
}

// ── Apply edits bottom-up per file ──────────────────────────────────────────
let fileCount = 0;
let editCount = 0;
const tally = { public: 0, alpha: 0, internal: 0 };
for (const [fileName, edits] of editsByFile) {
  edits.sort((a, b) => b.start - a.start);
  let text = readFileSync(fileName, "utf8");
  for (const e of edits) {
    text = text.slice(0, e.start) + e.text + text.slice(e.end);
    const m = e.text.match(/@(public|alpha|internal)/);
    if (m) tally[m[1]]++;
    editCount++;
  }
  writeFileSync(fileName, text);
  fileCount++;
}

console.log(
  `tagged ${editCount} symbols across ${fileCount} files ` +
    `(public=${tally.public} alpha=${tally.alpha} internal=${tally.internal})`,
);
