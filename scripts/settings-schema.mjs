/**
 * The settings schema, generated from the type that already exists.
 *
 * Hand-writing a JSON Schema for `Settings` would be maintaining the same list
 * twice, and a schema that lies is worse than none. So the list is read out of
 * src/settings.ts with TypeScript's own checker: the doc comment on each field
 * becomes `description` (the hover-help in an editor is then the same prose the
 * settings page argues in), the string unions become `enum`, `RANGES` supplies
 * the minimums and maximums the type alone cannot express, and `DEFAULTS`
 * supplies `default`.
 *
 * The generator is this file rather than ts-json-schema-generator because the
 * only two things that library would add here — resolving `ThemeId` and reading
 * doc comments — are both a call to the checker, and a dependency that has to
 * be told which fields are ranges is not much of a saving.
 *
 *   node scripts/settings-schema.mjs           write it
 *   node scripts/settings-schema.mjs --check   fail if the copies are stale
 *
 * Two copies: src/settings.schema.json, bundled so the app can write it beside
 * settings.json on every launch (which is what keeps it honest across
 * versions), and site/settings.schema.json, published at a stable URL for
 * anything else that wants it. --check runs in CI, because automation that can
 * be bypassed by editing one file by hand is not a guarantee.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const SOURCE = resolve(ROOT, "src/settings.ts");
const OUTPUTS = ["src/settings.schema.json", "site/settings.schema.json"];
const ID = "https://plans.ratulmaharaj.com/settings.schema.json";

/**
 * Bookkeeping the app writes to itself. They live in `Settings` because
 * splitting the type to relocate two keys buys a migration for no
 * reader-visible gain — so the schema is where they get labelled instead.
 */
const APP_MANAGED = new Set(["treeWidth", "lastSeenVersion"]);

const program = ts.createProgram([SOURCE], {
  strict: true,
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
});
const checker = program.getTypeChecker();
const file = program.getSourceFile(SOURCE);
if (!file) fail(`cannot read ${SOURCE}`);

function fail(message) {
  console.error(`settings-schema: ${message}`);
  process.exit(1);
}

/** The one exported statement with this name, whatever kind it is. */
function declarationOf(name) {
  for (const st of file.statements) {
    if (ts.isTypeAliasDeclaration(st) && st.name.text === name) return st;
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return d;
      }
    }
  }
  return null;
}

/** A literal node's value, seeing through `as const` and one hop of `const x = …`. */
function literalValue(node) {
  if (!node) return undefined;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return literalValue(node.expression);
  }
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isObjectLiteralExpression(node) && node.properties.length === 0) return {};
  if (ts.isIdentifier(node)) {
    // `theme: DEFAULT_THEME` — annotated `: ThemeId`, so the checker widens it
    // away. The declaration still has the literal.
    let sym = checker.getSymbolAtLocation(node);
    // `DEFAULT_THEME` and the prompts are imported, so the local symbol is an
    // alias; the declaration worth reading is the one it points at.
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym?.declarations?.find(ts.isVariableDeclaration);
    if (decl?.initializer && !ts.isIdentifier(decl.initializer)) {
      return literalValue(decl.initializer);
    }
  }
  return undefined;
}

/** `{ key: { min, max, step } }` out of an object literal of object literals. */
function objectOfObjects(name) {
  const decl = declarationOf(name);
  if (!decl?.initializer || !ts.isObjectLiteralExpression(decl.initializer)) {
    fail(`${name} is not an object literal`);
  }
  const out = {};
  for (const p of decl.initializer.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isObjectLiteralExpression(p.initializer)) continue;
    const key = p.name.getText(file).replace(/^"|"$/g, "");
    const inner = {};
    for (const q of p.initializer.properties) {
      if (!ts.isPropertyAssignment(q)) continue;
      inner[q.name.getText(file)] = literalValue(q.initializer);
    }
    out[key] = inner;
  }
  return out;
}

/** `{ key: literal }`, skipping anything that is not one. */
function objectOfLiterals(name) {
  const decl = declarationOf(name);
  if (!decl?.initializer || !ts.isObjectLiteralExpression(decl.initializer)) {
    fail(`${name} is not an object literal`);
  }
  const out = {};
  for (const p of decl.initializer.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const value = literalValue(p.initializer);
    if (value !== undefined) out[p.name.getText(file).replace(/^"|"$/g, "")] = value;
  }
  return out;
}

const RANGES = objectOfObjects("RANGES");
const DEFAULTS = objectOfLiterals("DEFAULTS");

/** What a `Settings` field looks like as a schema, before ranges and defaults. */
function shapeOf(name, type) {
  const F = ts.TypeFlags;
  if (type.isUnion()) {
    // `boolean` arrives here as `true | false`; everything else worth having is
    // a union of string literals, which is exactly an enum.
    if (type.flags & F.BooleanLike) return { type: "boolean" };
    const parts = type.types.filter((t) => !(t.flags & F.Undefined));
    if (parts.every((t) => t.isStringLiteral())) {
      return { type: "string", enum: parts.map((t) => t.value) };
    }
    if (parts.every((t) => t.flags & F.BooleanLike)) return { type: "boolean" };
    fail(`${name}: union of something other than string literals`);
  }
  if (type.flags & F.StringLike) return { type: "string" };
  if (type.flags & F.NumberLike) return { type: "number" };
  if (type.flags & F.BooleanLike) return { type: "boolean" };
  const index = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  if (index) {
    return {
      type: "object",
      additionalProperties: shapeOf(`${name}[]`, index.type),
    };
  }
  fail(`${name}: no schema for ${checker.typeToString(type)}`);
}

const alias = declarationOf("Settings");
if (!alias || !ts.isTypeAliasDeclaration(alias)) fail("no `Settings` type alias");
const settingsType = checker.getTypeAtLocation(alias.name);

const properties = {
  $schema: {
    type: "string",
    description:
      "Where this file's schema lives. Written by Plans, and rewritten on every launch so it always describes the build you are running.",
  },
};

for (const prop of checker.getPropertiesOfType(settingsType)) {
  const name = prop.getName();
  const decl = prop.valueDeclaration ?? prop.declarations?.[0];
  const shape = shapeOf(name, checker.getTypeOfSymbolAtLocation(prop, decl));
  const doc = ts.displayPartsToString(prop.getDocumentationComment(checker)).trim();
  const range = RANGES[name];

  const entry = { ...shape };
  const notes = [];
  if (doc) notes.push(doc.replace(/\s*\n\s*/g, " "));
  if (APP_MANAGED.has(name)) {
    notes.push("Managed by Plans — edit it here and the app will write over you.");
    entry.readOnly = true;
  }
  if (notes.length) entry.description = notes.join(" ");
  // Bounds only. `step` is how far the slider moves, not a rule about what the
  // number may be — and `multipleOf: 0.01` would fail values that are perfectly
  // fine, because that is what binary floating point does to a hundredth.
  if (range) {
    if (typeof range.min === "number") entry.minimum = range.min;
    if (typeof range.max === "number") entry.maximum = range.max;
  }
  if (name in DEFAULTS) entry.default = DEFAULTS[name];
  properties[name] = entry;
}

const known = Object.keys(properties).length - 1;
if (known < 10) fail(`only found ${known} settings — something is wrong`);

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: ID,
  title: "Plans settings",
  description:
    "Everything the reader can change in Plans, in one file. Generated from the app's own Settings type — do not edit by hand.",
  type: "object",
  // Kept, not rejected: a file written by a newer build should still open in
  // this one, and Plans writes unknown keys back untouched.
  additionalProperties: true,
  properties,
};

const text = `${JSON.stringify(schema, null, 2)}\n`;

let stale = false;
for (const out of OUTPUTS) {
  const path = resolve(ROOT, out);
  const current = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  })();
  if (current === text) continue;
  if (check) {
    console.error(`settings-schema: ${out} is stale — run \`pnpm run schema\``);
    stale = true;
  } else {
    writeFileSync(path, text);
    console.log(`settings-schema: wrote ${out} (${known} settings)`);
  }
}
if (stale) process.exit(1);
if (check) console.log(`settings-schema: up to date (${known} settings)`);
