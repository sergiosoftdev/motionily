import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every instruction Motionily gives a model lives in docs/agent (docs/agent/prompts/README.md): role prompts in
 * prompts/, the craft, manual and syntax they include beside them. The code only assembles them.
 */
const DOCS_DIR = resolve(process.env.MOTIONILY_DOCS_DIR ?? join(process.cwd(), "../../docs/agent"));
const PLACEHOLDER = /\{\{([^}]+)\}\}/g;
const INCLUDE = "include:";

const read = (path: string) => readFileSync(join(DOCS_DIR, path), "utf8").trim();

/** One `## NAME…` section of a doc, heading included, up to the next `## `. */
function section(path: string, name: string): string {
  const lines = read(path).split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## ${name}`));
  if (start < 0) throw new Error(`docs/agent/${path} has no "## ${name}" section`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end < 0 ? undefined : end).join("\n").trim();
}

/**
 * docs/agent/`path` with its placeholders filled: `{{include:craft.md}}` pastes a doc, `{{include:craft.md#NAME}}`
 * one of its sections, `{{name}}` a value from `vars`. An unknown name or a missing section throws, so a prompt
 * never ships with a hole.
 */
export function loadPrompt(path: string, vars: Record<string, string | number> = {}, depth = 0): string {
  if (depth > 4) throw new Error(`docs/agent/${path}: includes nest too deep`);
  return read(path).replace(PLACEHOLDER, (_, raw: string) => {
    const key = raw.trim();
    if (key.startsWith(INCLUDE)) {
      const [file, name] = key.slice(INCLUDE.length).split("#") as [string, string | undefined];
      return name ? section(file, name) : loadPrompt(file, vars, depth + 1);
    }
    if (!(key in vars)) throw new Error(`docs/agent/${path}: no value for {{${key}}}`);
    return String(vars[key]);
  });
}

/** A role prompt (docs/agent/prompts/NAME.md). */
export const rolePrompt = (name: string, vars?: Record<string, string | number>) => loadPrompt(`prompts/${name}.md`, vars);

/** Load every role prompt once (any value stands in for the code's) so a broken include fails at start-up. */
export function checkPrompts(): number {
  const anyValue = new Proxy({}, { has: () => true, get: () => "…" }) as Record<string, string>;
  const names = readdirSync(join(DOCS_DIR, "prompts")).filter((f) => f.endsWith(".md") && f !== "README.md");
  for (const f of names) loadPrompt(`prompts/${f}`, anyValue);
  return names.length;
}
