import { chromium, type Browser } from "playwright-core";
import { HEADLESS_PARAM, type User } from "@motionily/protocol";

const SESSION_KEY = "motionily.session";
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
/** WebGPU on Metal; SwiftShader is too slow for 3D. */
const CHROME_ARGS = ["--enable-unsafe-webgpu", "--use-angle=metal"];
const VIEWPORT = { width: 1360, height: 880 };
/** The API the agent works on (index.ts reads the same variable). */
const API_URL = process.env.MOTIONILY_API ?? "http://localhost:3100";
const PROBE_MS = 3000;

/**
 * An invisible editor the agent opens on its own project when the user has none open,
 * so it can apply ops, render and review the video without a human in the loop.
 * A real editor opened later replaces it on the bridge.
 */
export class HeadlessEditor {
  private browser: Promise<Browser> | null = null;

  constructor(
    private readonly webUrl: string,
    private readonly projectId: string,
    private readonly session: () => Promise<{ token: string; user: User }>,
  ) {
    for (const sig of ["exit", "SIGINT", "SIGTERM"] as const) process.once(sig, () => void this.close());
  }

  get running(): boolean {
    return this.browser !== null;
  }

  async open(): Promise<void> {
    if (this.browser) return;
    this.browser = this.launch().catch((e: Error) => {
      this.browser = null;
      throw new Error(`could not start the headless editor: ${e.message}`);
    });
    await this.browser;
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    await (await b?.catch(() => null))?.close().catch(() => undefined);
  }

  /**
   * Where the editor is served: MOTIONILY_WEB when set, else the API itself when it serves the
   * editor build (the desktop app, which runs no web server), else the default web URL.
   */
  private async editorUrl(): Promise<string> {
    if (process.env.MOTIONILY_WEB) return this.webUrl;
    const res = await fetch(`${API_URL}/index.html`, { signal: AbortSignal.timeout(PROBE_MS) }).catch(() => null);
    return res?.ok && res.headers.get("content-type")?.includes("text/html") ? API_URL : this.webUrl;
  }

  private async launch(): Promise<Browser> {
    const session = await this.session();
    const webUrl = await this.editorUrl();
    const browser = await chromium.launch({ executablePath: process.env.MOTIONILY_CHROME ?? DEFAULT_CHROME, headless: true, args: CHROME_ARGS });
    const page = await browser.newPage({ viewport: VIEWPORT });
    // The editor talks to the agent's API, wherever the page itself is served from.
    await page.addInitScript(
      ([key, value, api]) => {
        localStorage.setItem(key!, value!);
        Object.assign(window, { __MOTIONILY_API__: api });
      },
      [SESSION_KEY, JSON.stringify(session), API_URL],
    );
    page.on("pageerror", (e) => console.error(`[motionily] headless editor: ${e.message}`));
    page.on("close", () => void this.close());
    await page.goto(`${webUrl}/?${HEADLESS_PARAM}=1#/p/${this.projectId}`);
    console.error(`[motionily] opened a headless editor on project ${this.projectId}`);
    return browser;
  }
}
