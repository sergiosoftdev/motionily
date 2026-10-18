#!/usr/bin/env node
/**
 * Motionily MCP server: the agent's hands. The agent builds and edits videos
 * with small ops; the human watches the editor, picks styles and leaves
 * feedback, which the agent reads back with `get_feedback`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BRIDGE_PORT, FeedbackKind, type Feedback, type Op } from "@motionily/protocol";
import { EditorBridge } from "./bridge.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const REFERENCE = readFileSync(resolve(here, "../../../docs/scene-reference.md"), "utf8");
const projectPath = resolve(process.env.MOTIONILY_PROJECT ?? "project.motionily.json");
const bridge = new EditorBridge(Number(process.env.MOTIONILY_PORT ?? BRIDGE_PORT), projectPath);

const server = new McpServer({ name: "motionily", version: "0.1.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ ...text(t), isError: true });

server.registerTool(
  "get_reference",
  {
    description:
      "Scene format and op reference. Read once per session before your first edit; it is not repeated elsewhere.",
    inputSchema: {},
  },
  async () => text(REFERENCE),
);

server.registerTool(
  "get_scene",
  {
    description:
      "Current scene. Default is a compact one-line-per-layer summary (cheap). Use full=true only when you need exact keyframes.",
    inputSchema: { full: z.boolean().optional() },
  },
  async ({ full }) => {
    if (full) return text(bridge.savedScene() ?? "No scene saved yet.");
    if (bridge.lastSummary) return text(bridge.lastSummary);
    return fail("No scene yet. Is the editor open?");
  },
);

server.registerTool(
  "apply_ops",
  {
    description:
      "Edit the video with a batch of ops (atomic: all or nothing). Returns the new summary. Prefer this over load_scene for any change.",
    inputSchema: { ops: z.array(z.looseObject({ op: z.string() })).min(1) },
  },
  async ({ ops }) => {
    try {
      const res = await bridge.applyOps(ops as Op[]);
      return res.ok ? text(res.summary ?? "ok") : fail(res.error ?? "rejected");
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "load_scene",
  {
    description: "Replace the whole scene with new JSON. Use only to start a video from scratch.",
    inputSchema: { scene: z.string().describe("Full scene JSON") },
  },
  async ({ scene }) => {
    try {
      const res = await bridge.loadScene(scene);
      return res.ok ? text(res.summary ?? "ok") : fail(res.error ?? "rejected");
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "get_feedback",
  {
    description:
      "What the user did in the editor since the last call: comments pinned to a time, style and caption choices. Check it after each round of edits.",
    inputSchema: {},
  },
  async () => {
    const items = bridge.drainFeedback();
    if (items.length === 0) return text("No new feedback.");
    return text(items.map(formatFeedback).join("\n"));
  },
);

function formatFeedback(f: Feedback): string {
  switch (f.kind) {
    case FeedbackKind.Comment:
      return `comment @${f.at.toFixed(2)}s: ${f.text}`;
    case FeedbackKind.StyleChosen:
      return `user chose style=${f.style} (already applied)`;
    case FeedbackKind.CaptionStyleChosen:
      return `user chose captions=${f.captionStyle} (already applied)`;
  }
}

await server.connect(new StdioServerTransport());
