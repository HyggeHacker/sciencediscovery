#!/usr/bin/env bun
/**
 * seam spike: crossings, base-vs-head newness, the one comment, and `declare`.
 * (SPEC.md §5.2 derived-surface diff, §5.5 comment shape, §10 step 0.)
 *
 *   bun Diff.ts init   [--repo DIR]                       coverage + every crossing on the working tree
 *   bun Diff.ts diff   [--repo DIR] [--base REF] [--head REF] [--block-dev-plane]
 *   bun Diff.ts diff   --base-dir DIR --head-dir DIR       fixture mode, no git
 *   bun Diff.ts declare flow --from A --to B --carries x,y --boundary Z [--repo DIR]
 *
 * Exit 0 clean, 1 blocking crossings present, 2 usage error.
 * Blocking = new, undeclared crossings on a product-plane file. Dev-plane
 * crossings (the contributor's editor agent) are listed, and block only with
 * --block-dev-plane. The model stand-in is `.seam/boundaries.yaml`:
 *   boundaries: [{ name, tier?, source? }]
 *   placements: { <element>: <boundary> }
 *   flows: [{ from, to, carries: [..] }]        # declared crossings
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { coverageLine, derive, type Coverage, type Derived, type Flow, type Plane } from "./Derive.ts";

export type Model = {
  boundaries: Array<{ name: string; tier?: string; source?: string }>;
  placements: Record<string, string>;
  flows: Array<{ from: string; to: string; carries: string[] }>;
};

const EMPTY: Model = { boundaries: [], placements: {}, flows: [] };
const MODEL_PATH = ".seam/boundaries.yaml";
export const COMMENT_MARKER = "<!-- seam-spike-comment -->";

export function loadModel(root: string): Model {
  const p = join(root, MODEL_PATH);
  if (!existsSync(p)) return EMPTY;
  const doc = (Bun.YAML.parse(readFileSync(p, "utf8")) ?? {}) as Partial<Model>;
  return {
    boundaries: doc.boundaries ?? [],
    placements: doc.placements ?? {},
    flows: (doc.flows ?? []).map((f) => ({ ...f, carries: [...(f.carries ?? [])].sort() })),
  };
}

const flowKey = (f: { from: string; to: string; carries: string[] }) => `${f.from}|${f.to}|${[...f.carries].sort().join(",")}`;
export const crossingId = (f: { from: string; to: string; carries: string[] }) =>
  "X-" + createHash("sha256").update(flowKey(f)).digest("hex").slice(0, 8);

export type Crossing = { id: string; flow: Flow; fromBoundary: string; toBoundary: string; declared: boolean; plane: Plane };

/** Boundary of an element: human placement wins, then the derived boundary, then B00. */
function boundaryOf(name: string, derived: Derived, model: Model): string {
  if (model.placements[name]) return model.placements[name];
  return derived.elements.find((e) => e.name === name)?.boundary ?? "B00";
}

/** Every derived flow whose endpoints sit in different boundaries, evaluated under `model`. */
export function crossings(derived: Derived, model: Model): Crossing[] {
  const declared = new Set(model.flows.map(flowKey));
  const out: Crossing[] = [];
  for (const flow of derived.flows) {
    const a = boundaryOf(flow.from, derived, model);
    const b = boundaryOf(flow.to, derived, model);
    if (a === b) continue;
    const plane = (flow.attrs.plane as Plane) ?? "dev-plane";
    out.push({ id: crossingId(flow), flow, fromBoundary: a, toBoundary: b, declared: declared.has(flowKey(flow)), plane });
  }
  return out.sort((x, y) => x.id.localeCompare(y.id));
}

export type DiffResult = {
  coverage: Coverage;
  undeclared: Crossing[]; // new on head AND undeclared, all planes
  baselineUndeclared: Crossing[]; // undeclared but pre-existing on base
  declaredCount: number;
  modelChanged: boolean;
};

/** SPEC §5.2: newness is "absent from the base derived surface evaluated under head's boundaries". */
export function diff(baseRoot: string | null, headRoot: string): DiffResult {
  const head = derive(headRoot);
  const headModel = loadModel(headRoot);
  const headX = crossings(head.derived, headModel);
  let baseKeys = new Set<string>();
  let modelChanged = false;
  if (baseRoot) {
    const base = derive(baseRoot);
    baseKeys = new Set(crossings(base.derived, headModel).map((c) => c.id));
    modelChanged = JSON.stringify(loadModel(baseRoot)) !== JSON.stringify(headModel);
  }
  const undeclaredAll = headX.filter((c) => !c.declared);
  return {
    coverage: head.coverage,
    undeclared: undeclaredAll.filter((c) => !baseKeys.has(c.id)),
    baselineUndeclared: undeclaredAll.filter((c) => baseKeys.has(c.id)),
    declaredCount: headX.length - undeclaredAll.length,
    modelChanged,
  };
}

export const blocking = (r: DiffResult, blockDevPlane = false) => r.undeclared.filter((c) => blockDevPlane || c.plane === "product");

function renderCrossing(c: Crossing): string[] {
  const src = c.flow.source.replace(/^derive:mcp-config:/, "");
  return [
    `  ${c.id}  undeclared crossing  ${c.flow.from} (agent, ${c.fromBoundary}) -> ${c.flow.to} (mcp-server, ${c.toBoundary})  [${c.plane}]`,
    `        carries: ${c.flow.carries.join(", ")}        source: ${src}`,
    `        declare:  seam declare flow --from ${c.flow.from} --to ${c.flow.to} --carries ${c.flow.carries.join(",")} --boundary <the zone ${c.flow.to} belongs in>`,
  ];
}

export function renderComment(r: DiffResult, opts: { mode: "init" | "diff"; blockDevPlane?: boolean }): string {
  const lines: string[] = [];
  const block = blocking(r, opts.blockDevPlane);
  const rest = r.undeclared.filter((c) => !block.includes(c));
  const n = r.undeclared.length;
  const model = opts.mode === "init" ? "" : ` Model: ${r.modelChanged ? "changed" : "unchanged"}.`;
  if (n === 0) {
    lines.push(`seam: no undeclared crossings among what seam can see, no new findings.${model}`);
    lines.push(coverageLine(r.coverage));
  } else {
    const parts = [`${block.length} blocking`, ...(rest.length ? [`${rest.length} dev-plane`] : [])];
    lines.push(`seam: ${n} undeclared crossing${n === 1 ? "" : "s"} (${parts.join(", ")}), 0 new findings.${model}`);
    lines.push(coverageLine(r.coverage));
    if (block.length) {
      lines.push("", "BLOCKS MERGE");
      for (const c of block) lines.push(...renderCrossing(c), "");
    }
    if (rest.length) {
      lines.push("", "DEV-PLANE CROSSINGS (comment only; the contributor's editor agent, not the product)");
      for (const c of rest) lines.push(...renderCrossing(c), "");
    }
  }
  if (r.baselineUndeclared.length) {
    lines.push(`baseline: ${r.baselineUndeclared.length} undeclared crossing${r.baselineUndeclared.length === 1 ? "" : "s"} pre-existing on base, unchanged.`);
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Materialise the full tree at a git ref into a temp dir (classification needs source files). */
export function checkoutRef(repo: string, ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), "seam-ref-"));
  const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", ref], { maxBuffer: 1 << 30 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar, maxBuffer: 1 << 30 });
  return dir;
}

function declareFlow(root: string, args: Record<string, string>): number {
  const { from, to, carries, boundary } = args;
  if (!from || !to || !carries || !boundary) {
    console.error("usage: declare flow --from A --to B --carries x,y --boundary Z");
    return 2;
  }
  const model = loadModel(root);
  if (!model.boundaries.some((b) => b.name === boundary)) {
    console.error(`refused: boundary "${boundary}" is not declared in ${MODEL_PATH}; declare it first (the zone is the human's call).`);
    return 2;
  }
  const carriesList = carries.split(",").map((s) => s.trim()).filter(Boolean).sort();
  model.placements[to] = boundary;
  if (!model.flows.some((f) => flowKey(f) === flowKey({ from, to, carries: carriesList }))) {
    model.flows.push({ from, to, carries: carriesList });
  }
  writeModel(root, model);
  console.log(`declared ${from}->${to} [${carriesList.join(",")}]; ${to} placed in ${boundary} (ASSERTED).`);
  return 0;
}

/** Block-style YAML by hand; Bun.YAML.stringify emits flow style. */
export function writeModel(root: string, m: Model): void {
  const out: string[] = ["# seam spike model stand-in. Every entry here is a human's ASSERTED statement.", "boundaries:"];
  for (const b of m.boundaries) out.push(`  - name: ${b.name}`, ...(b.source ? [`    source: ${JSON.stringify(b.source)}`] : []));
  if (!m.boundaries.length) out[out.length - 1] = "boundaries: []";
  out.push("placements:");
  const keys = Object.keys(m.placements).sort();
  if (!keys.length) out[out.length - 1] = "placements: {}";
  for (const k of keys) out.push(`  ${JSON.stringify(k)}: ${m.placements[k]}`);
  out.push("flows:");
  if (!m.flows.length) out[out.length - 1] = "flows: []";
  for (const f of m.flows) out.push(`  - from: ${f.from}`, `    to: ${f.to}`, `    carries: [${f.carries.join(", ")}]`);
  const p = join(root, MODEL_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, out.join("\n") + "\n");
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const BOOL = new Set(["block-dev-plane"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      flags[k] = BOOL.has(k) ? "true" : (argv[++i] ?? "");
    } else positional.push(a);
  }
  return { positional, flags };
}

if (import.meta.main) {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const repo = resolve(flags.repo ?? process.cwd());
  const blockDevPlane = flags["block-dev-plane"] === "true";

  if (cmd === "init") {
    const r = diff(null, repo);
    process.stdout.write(renderComment(r, { mode: "init", blockDevPlane }));
    process.exit(blocking(r, blockDevPlane).length ? 1 : 0);
  } else if (cmd === "diff") {
    let baseRoot: string;
    let headRoot: string;
    if (flags["base-dir"] || flags["head-dir"]) {
      baseRoot = resolve(flags["base-dir"]);
      headRoot = resolve(flags["head-dir"]);
    } else {
      baseRoot = checkoutRef(repo, flags.base ?? "HEAD");
      headRoot = flags.head ? checkoutRef(repo, flags.head) : repo;
    }
    const r = diff(baseRoot, headRoot);
    process.stdout.write(renderComment(r, { mode: "diff", blockDevPlane }));
    process.exit(blocking(r, blockDevPlane).length ? 1 : 0);
  } else if (cmd === "declare" && positional[1] === "flow") {
    process.exit(declareFlow(repo, flags));
  } else {
    console.error("usage: Diff.ts init|diff|declare flow [...]   (see file header)");
    process.exit(2);
  }
}
