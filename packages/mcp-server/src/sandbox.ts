/**
 * Code Mode: the agent writes one script instead of a chain of tool calls. It runs in a QuickJS
 * (WebAssembly) sandbox with no files, network or Node APIs, only the host functions it is given
 * (`mo.*`) and console.log. Intermediate data (scenes, layouts, lint) stays in the script; only what
 * it logs or returns goes back to the model, which is where the tokens are saved.
 *
 * Host calls look synchronous inside the sandbox (asyncify), so scripts never need await.
 */
import { newAsyncContext, type QuickJSHandle } from "quickjs-emscripten";

/** A host function a script can call: arguments and result travel as JSON. */
export type HostFn = (...args: unknown[]) => Promise<unknown>;
export type HostApi = Record<string, HostFn>;

export type ScriptResult = {
  ok: boolean;
  /** What the script returned (JSON-safe), when it returned something. */
  value?: unknown;
  error?: string;
  logs: string[];
  /** Host calls made. */
  calls: number;
  /** Wall time, host calls included. */
  ms: number;
};

const MEMORY_BYTES = 64 * 1024 * 1024;
const STACK_BYTES = 1024 * 1024;
/** Logged characters kept (the rest is cut, with a note): the log is what reaches the model. */
export const LOG_CHARS = 6000;

/** `await` and `async` do nothing useful here (host calls are synchronous); dropping them lets natural code run. */
const desugar = (code: string) => code.replace(/\bawait\s+/g, "").replace(/\basync\s+(?=function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g, "");

/**
 * Run `code` (a function body: statements, optional `return`) with `mo` bound to `api`.
 * `cpuMs` limits time spent inside the sandbox; time waiting on host calls does not count.
 */
export async function runScript(code: string, api: HostApi, cpuMs: number): Promise<ScriptResult> {
  const vm = await newAsyncContext();
  vm.runtime.setMemoryLimit(MEMORY_BYTES);
  vm.runtime.setMaxStackSize(STACK_BYTES);
  const started = Date.now();
  let hostMs = 0;
  let calls = 0;
  vm.runtime.setInterruptHandler(() => Date.now() - started - hostMs > cpuMs);

  const logs: string[] = [];
  let logged = 0;
  const log = (line: string) => {
    if (logged >= LOG_CHARS) return;
    const room = LOG_CHARS - logged;
    logs.push(line.length > room ? `${line.slice(0, room)}… (log cut at ${LOG_CHARS} chars)` : line);
    logged += Math.min(line.length, room);
  };

  // One entry point: __host(name, argsJson) -> resultJson. The prelude wraps it as mo.<name>(...).
  const host = vm.newAsyncifiedFunction("__host", async (nameH: QuickJSHandle, argsH: QuickJSHandle) => {
    const name = vm.getString(nameH);
    const fn = api[name];
    if (!fn) return { error: vm.newError(`mo.${name} does not exist`) };
    calls += 1;
    const t0 = Date.now();
    try {
      const out = await fn(...(JSON.parse(vm.getString(argsH)) as unknown[]));
      return vm.newString(JSON.stringify(out ?? null));
    } catch (e) {
      return { error: vm.newError(e instanceof Error ? e.message : String(e)) };
    } finally {
      hostMs += Date.now() - t0;
    }
  });
  vm.setProp(vm.global, "__host", host);
  host.dispose();
  const print = vm.newFunction("__log", (lineH: QuickJSHandle) => {
    log(vm.getString(lineH));
  });
  vm.setProp(vm.global, "__log", print);
  print.dispose();

  const prelude = [
    `const __fmt = (v) => typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();`,
    `const console = { log: (...a) => __log(a.map(__fmt).join(" ")) };`,
    `const mo = {${Object.keys(api)
      .map((n) => `${JSON.stringify(n)}: (...a) => JSON.parse(__host(${JSON.stringify(n)}, JSON.stringify(a)))`)
      .join(", ")}};`,
  ].join("\n");
  const source = `"use strict";\n${prelude}\nJSON.stringify((function () {\n${desugar(code)}\n})() ?? null);`;

  try {
    const res = await vm.evalCodeAsync(source, "script.js");
    if (res.error) {
      const err = vm.dump(res.error) as { name?: string; message?: string } | string;
      res.error.dispose();
      const message = typeof err === "string" ? err : `${err?.name ?? "Error"}: ${err?.message ?? "unknown"}`;
      return { ok: false, error: /interrupted/i.test(message) ? `stopped after ${cpuMs} ms of script time` : message, logs, calls, ms: Date.now() - started };
    }
    const json = vm.getString(res.value);
    res.value.dispose();
    const value = JSON.parse(json) as unknown;
    return { ok: true, value: value === null ? undefined : value, logs, calls, ms: Date.now() - started };
  } finally {
    vm.dispose();
  }
}
