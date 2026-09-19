#!/usr/bin/env bun
/**
 * seam spike: the `mcp-config` deriver (SPEC.md §5.2, §10 step 0).
 *
 * Reads MCP client config files at a repo root and emits INFERRED nodes:
 * one `host` agent in B00 per config file, one `tool-plane/<transport>`
 * boundary per transport class, one `mcp-server` element per server, and
 * one `host -> server` flow per server. Never reads a ledger, never
 * connects to anything, never emits above INFERRED.
 *
 * Every discovered file is classified `product` or `dev-plane` by greppable
 * signals (SURVEY-2026-09-17 §Population 3). The classification is a fact
 * about the file, stamped on the host element and reported in coverage.
 *
 * Usage:  bun Derive.ts [repo-dir]        prints derived JSON + coverage
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const DERIVER = { name: "mcp-config", version: 2 } as const;
export const ENGINE = "spike-0.2";

export const BLIND = [
  "programmatic MCP clients",
  "in-code HTTP tools",
  "subprocess tools",
  "A2A",
  "anything not in a config file",
  "config files below the repo root other than the listed host paths",
];
export const CAVEAT =
  "a dev-plane file is the contributor's editor agent, not the shipped product; both are trust boundaries";

/**
 * Files the deriver always looks for, relative to repo root, with the key that
 * holds the server map and the host that reads the file. `mcpServers` is the
 * common shape; opencode uses `mcp`, VS Code uses `servers`.
 */
export const KNOWN_PATHS: Array<{ path: string; key: string; host: string }> = [
  { path: ".mcp.json", key: "mcpServers", host: "claude-code" },
  { path: "mcp.json", key: "mcpServers", host: "codex" },
  { path: "claude_desktop_config.json", key: "mcpServers", host: "claude-desktop" },
  { path: ".cursor/mcp.json", key: "mcpServers", host: "cursor" },
  { path: ".vscode/mcp.json", key: "servers", host: "vscode" },
  { path: ".gemini/settings.json", key: "mcpServers", host: "gemini-cli" },
  { path: "gemini-extension.json", key: "mcpServers", host: "gemini-cli" },
  { path: "opencode.json", key: "mcp", host: "opencode" },
  { path: "extensions_config.json", key: "mcpServers", host: "deer-flow" },
  { path: "mcp_config.json", key: "mcpServers", host: "deer-flow" },
];

/** Sibling files that mark a config as a plugin's shipped surface. */
const PLUGIN_MANIFESTS = [".claude-plugin/plugin.json", "plugin.json", "gemini-extension.json"];

export type Tier = "INFERRED";
export type Plane = "product" | "dev-plane";
export type Boundary = { name: string; tier: Tier; source: string };
export type Element = {
  name: string;
  kind: "agent" | "mcp-server";
  boundary: string; // "B00" for unassigned
  tier: Tier;
  source: string;
  attrs: Record<string, unknown>;
};
export type Flow = {
  name: string;
  from: string;
  to: string;
  carries: string[];
  protocol: string;
  tier: Tier;
  source: string;
  attrs: Record<string, unknown>;
};
export type Input = { path: string; sha256: string; host: string; plane: Plane; signal: string };
export type Derived = {
  seam: 1;
  engine: string;
  derivers: Array<{
    name: string;
    version: number;
    inputs: Input[];
    blind: string[];
    caveat: string;
  }>;
  boundaries: Boundary[];
  elements: Element[];
  flows: Flow[];
};

export type Coverage = {
  deriver: string;
  version: number;
  files: Input[];
  servers: number;
  blind: string[];
  caveat: string;
};

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** Every candidate config file under the root, deduplicated, in stable order. */
export function discover(root: string): Array<{ path: string; key: string; host: string }> {
  const found = new Map<string, { path: string; key: string; host: string }>();
  for (const k of KNOWN_PATHS) if (existsSync(join(root, k.path)) && statSync(join(root, k.path)).isFile()) found.set(k.path, k);
  // Any other JSON/YAML at the root carrying an `mcpServers` block.
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const f of entries.sort()) {
    if (found.has(f) || !/\.(json|ya?ml)$/i.test(f)) continue;
    const full = join(root, f);
    if (!statSync(full).isFile()) continue;
    if (readFileSync(full, "utf8").includes("mcpServers")) found.set(f, { path: f, key: "mcpServers", host: "unknown" });
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}

type ServerBlock = Record<string, unknown>;

function parseConfig(path: string, key: string, text: string): Record<string, ServerBlock> | null {
  let doc: unknown;
  try {
    doc = /\.ya?ml$/i.test(path) ? Bun.YAML.parse(text) : JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object") return null;
  const servers = (doc as Record<string, unknown>)[key];
  if (!servers || typeof servers !== "object") return null;
  return servers as Record<string, ServerBlock>;
}

/** 1-based line of the server's key inside the file; 0 when not found. */
function lineOf(text: string, key: string, serverName: string): number {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.includes(key));
  const needle = new RegExp(`^\\s*["']?${serverName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*:`);
  for (let i = Math.max(start, 0); i < lines.length; i++) if (needle.test(lines[i])) return i + 1;
  return 0;
}

function transportOf(s: ServerBlock): string {
  const t = typeof s.type === "string" ? s.type.toLowerCase() : "";
  if (t === "stdio" || t === "http" || t === "sse") return t;
  if (t === "streamable-http" || t === "remote") return "http";
  if (t === "local") return "stdio";
  if (typeof s.url === "string") return "http";
  if (typeof s.command === "string" || Array.isArray(s.command)) return "stdio";
  return "unknown";
}

const SECRET_KEY = /(token|key|secret|password|passwd|credential|auth)/i;

/** True when the block visibly carries a credential. Names only, never values. */
function carriesToken(s: ServerBlock): boolean {
  const headers = s.headers;
  if (headers && typeof headers === "object" && Object.keys(headers).some((k) => /authorization|x-api-key|token/i.test(k))) return true;
  const env = s.env ?? s.environment;
  if (env && typeof env === "object" && Object.keys(env).some((k) => SECRET_KEY.test(k))) return true;
  if ("oauth" in s || "auth" in s) return true;
  const args = Array.isArray(s.args) ? (s.args as unknown[]) : Array.isArray(s.command) ? (s.command as unknown[]).slice(1) : [];
  if (args.some((a) => typeof a === "string" && /^[A-Z0-9_]*(TOKEN|KEY|SECRET|PASSWORD)[A-Z0-9_]*=/i.test(a))) return true;
  return false;
}

function audienceOf(s: ServerBlock): string | undefined {
  if (typeof s.url !== "string") return undefined;
  try {
    return new URL(s.url).host;
  } catch {
    return undefined;
  }
}

const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|py|rs|go|rb|java|kt|swift|sh)$/i;
// `.seam` and `.github` are excluded so the vendored spike (whose path table
// names every config filename) and the workflow never count as the reader.
const SKIP_DIR = new Set(["node_modules", ".git", ".seam", ".github", "dist", "build", "target", "vendor", ".venv", "venv", "__pycache__"]);

/** Non-test source files under root, bounded so a monorepo cannot stall the run. */
function sourceFiles(root: string, limit = 4000): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIR.has(e) && !/test/i.test(e)) stack.push(full);
      } else if (SOURCE_EXT.test(e) && !/test|spec/i.test(e)) out.push(full);
    }
  }
  return out;
}

/**
 * Classify one config file. Four signals mark product; an explicit empty SDK
 * setting source marks dev-plane; absent all five, dev-plane by default.
 */
export function classify(root: string, rel: string, sources: string[]): { plane: Plane; signal: string } {
  const base = rel.split("/").pop()!;
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reader = new RegExp(`(?<![\\w-])${esc}(?![\\w-])`);
  const settingProject = /setting_?[sS]ources\s*[:=]\s*\[[^\]]*["']project["']/;
  const settingEmpty = /setting_?[sS]ources\s*[:=]\s*\[\s*\]/;
  const loaderEnv = /EXTENSIONS_CONFIG_PATH|MCP_CONFIG_PATH/;

  for (const m of PLUGIN_MANIFESTS) if (m !== rel && existsSync(join(root, m))) return { plane: "product", signal: `plugin manifest ${m}` };

  let empty: string | null = null;
  for (const f of sources) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const at = relative(root, f);
    if (reader.test(text)) return { plane: "product", signal: `read by ${at}` };
    if (settingProject.test(text)) return { plane: "product", signal: `SDK setting source includes project in ${at}` };
    if (loaderEnv.test(text)) return { plane: "product", signal: `host loader env in ${at}` };
    if (empty === null && settingEmpty.test(text)) empty = at;
  }
  if (empty) return { plane: "dev-plane", signal: `SDK setting sources explicitly empty in ${empty}` };
  return { plane: "dev-plane", signal: "no reader, manifest, or setting source found" };
}

export function derive(rootIn: string): { derived: Derived; coverage: Coverage } {
  const root = resolve(rootIn);
  const files = discover(root);
  const sources = files.length ? sourceFiles(root) : [];
  const inputs: Input[] = [];
  const boundaries = new Map<string, Boundary>();
  const elements: Element[] = [];
  const flows: Flow[] = [];
  let servers = 0;

  for (const { path: rel, key, host } of files) {
    const text = readFileSync(join(root, rel), "utf8");
    const { plane, signal } = classify(root, rel, sources);
    inputs.push({ path: rel, sha256: sha256(text), host, plane, signal });
    const cfg = parseConfig(rel, key, text);
    if (!cfg) continue;

    const hostName = files.length === 1 ? "host" : `host:${rel}`;
    elements.push({
      name: hostName,
      kind: "agent",
      boundary: "B00",
      tier: "INFERRED",
      source: `derive:mcp-config:${rel}`,
      attrs: { synthesized: true, config: rel, host, plane, signal },
    });

    for (const [name, block] of Object.entries(cfg)) {
      if (!block || typeof block !== "object") continue;
      servers++;
      const transport = transportOf(block);
      const bName = `tool-plane/${transport}`;
      const line = lineOf(text, key, name);
      const src = `derive:mcp-config:${rel}${line ? `:${line}` : ""}`;
      if (!boundaries.has(bName)) boundaries.set(bName, { name: bName, tier: "INFERRED", source: src });

      const attrs: Record<string, unknown> = { transport };
      const aud = audienceOf(block);
      if (aud) attrs.audience = aud;
      if (typeof block.command === "string") attrs.command = block.command;
      elements.push({ name, kind: "mcp-server", boundary: bName, tier: "INFERRED", source: src, attrs });

      const carries = ["tool-call"];
      if (carriesToken(block)) carries.push("bearer-token");
      flows.push({
        name: `${hostName}->${name}`,
        from: hostName,
        to: name,
        carries: carries.sort(),
        protocol: `mcp/${transport}`,
        tier: "INFERRED",
        source: src,
        attrs: { plane },
      });
    }
  }

  const derived: Derived = {
    seam: 1,
    engine: ENGINE,
    derivers: [{ ...DERIVER, inputs, blind: BLIND, caveat: CAVEAT }],
    boundaries: [...boundaries.values()].sort((a, b) => a.name.localeCompare(b.name)),
    elements: elements.sort((a, b) => a.name.localeCompare(b.name)),
    flows: flows.sort((a, b) => a.name.localeCompare(b.name)),
  };
  const coverage: Coverage = { deriver: DERIVER.name, version: DERIVER.version, files: inputs, servers, blind: BLIND, caveat: CAVEAT };
  return { derived, coverage };
}

export function coverageLine(c: Coverage): string {
  const filesPart = c.files.length
    ? `${c.files.length} file${c.files.length === 1 ? "" : "s"}: ${c.files.map((f) => `${f.path} [${f.plane}: ${f.signal}]`).join(", ")}`
    : "0 files";
  return `coverage: ${c.deriver} (${filesPart}; ${c.servers} server${c.servers === 1 ? "" : "s"}). Blind to: ${c.blind.join(", ")}. Caveat: ${c.caveat}.`;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const { derived, coverage } = derive(root);
  console.log(JSON.stringify(derived, null, 2));
  console.error(coverageLine(coverage));
}
