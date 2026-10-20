import { useEffect, useState, type CSSProperties } from "react";

/** Seconds of the demo loop; every animation in it shares this clock (see `.lp-loop` in index.css). */
const LOOP_S = 12;
const SCENE_S = LOOP_S / 4;

const delay = (s: number) => ({ "--d": `${s}s` }) as CSSProperties;

/** Captions of each scene, highlighted word by word like Motionily's own captions. */
const CAPTIONS = [["Say", "it."], ["Watch", "it", "move."], ["Every", "beat", "on", "a", "word."], ["This", "is", "Motionily."]];

/** What the agent reports while it directs the demo video. */
const STEPS = ["Wrote the script · 38 words", "Designed 4 scenes", "Timed every beat to your voice", "Placed sound on the beats", "Checked its own frames"];

/** Requests typed into the ask box, one after another. */
const REQUESTS = ["Make the title bolder", "Warmer colors in the intro", "Bounce the logo in at 0:09", "Slower camera on scene 2"];

const TYPE_MS = 55;
const HOLD_MS = 1700;
const GAP_MS = 400;

function useTypewriter(lines: string[]) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setText(lines[0] ?? "");
      return;
    }
    let line = 0;
    let i = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const full = lines[line] ?? "";
      if (i < full.length) {
        i++;
        setText(full.slice(0, i));
        timer = setTimeout(tick, i === full.length ? HOLD_MS : TYPE_MS);
        return;
      }
      i = 0;
      line = (line + 1) % lines.length;
      setText("");
      timer = setTimeout(tick, GAP_MS);
    };
    timer = setTimeout(tick, GAP_MS);
    return () => clearTimeout(timer);
  }, [lines]);
  return text;
}

/**
 * The hero's product shot: Motionily's Simple mode with a video playing (pure CSS, one 12 s
 * loop), its moments and playhead, the agent's progress and a request being typed.
 */
export function HeroDemo() {
  const typed = useTypewriter(REQUESTS);
  return (
    <div className="lp-glass rounded-[28px] p-2 sm:p-3">
      <div className="flex items-center gap-3 px-3 pt-1 pb-3 text-xs text-neutral-400">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
          <span className="size-2.5 rounded-full bg-white/15" />
        </span>
        <span className="truncate text-neutral-300">Day 3 · Inside the engine</span>
        <span className="ml-auto hidden rounded-lg bg-white/5 p-0.5 sm:flex" aria-hidden>
          <span className="rounded-md bg-white px-2.5 py-0.5 font-medium text-neutral-900">Simple</span>
          <span className="px-2.5 py-0.5">Pro</span>
        </span>
        <span className="hidden rounded-lg bg-white/10 px-2.5 py-1 font-medium text-white sm:inline" aria-hidden>
          Export
        </span>
      </div>

      <div className="grid gap-3 rounded-[20px] bg-black/60 p-4 sm:p-6 md:grid-cols-[minmax(0,1fr)_320px] md:gap-6">
        <div className="flex flex-col items-center gap-4">
          <DemoVideo />
          <DemoTimeline />
        </div>

        <div className="flex flex-col gap-4 md:pt-2">
          <div className="flex items-center gap-2.5">
            <img src="/brand/mark.png" alt="" className="h-6 w-auto rounded-md" />
            <span className="text-sm font-semibold text-white">Claude is directing</span>
            <span className="ml-auto flex items-center gap-1.5 text-xs text-emerald-300/90">
              <span className="size-1.5 animate-pulse rounded-full bg-emerald-400" /> live
            </span>
          </div>
          <ol className="flex flex-col gap-2.5">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-2.5 text-[13px]">
                <span className="relative flex size-5 shrink-0 items-center justify-center rounded-full bg-white/5 ring-1 ring-white/10">
                  <svg viewBox="0 0 16 16" className="lp-loop lp-check size-3 text-emerald-300" style={delay(0.4 + i * 2)} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m3.5 8.5 3 3 6-7" />
                  </svg>
                </span>
                <span className="lp-loop lp-text-in" style={delay(0.4 + i * 2)}>
                  {s}
                </span>
              </li>
            ))}
          </ol>

          <div className="mt-auto flex flex-col gap-2 rounded-2xl bg-white/[0.04] p-3 ring-1 ring-white/10">
            <div className="flex gap-1.5 text-[11px]" aria-hidden>
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-white">Whole video</span>
              <span className="rounded-full px-2 py-0.5 text-neutral-500 ring-1 ring-white/10">At 0:04</span>
            </div>
            <div className="flex items-end gap-2">
              <p className="min-h-10 flex-1 text-sm text-neutral-200" aria-label="Example request">
                {typed}
                <span className="lp-caret ml-px inline-block h-4 w-px translate-y-0.5 bg-white" />
              </p>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-neutral-900" aria-hidden>
                <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                </svg>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The 9:16 video: four scenes in liquid glass, red and white, with word-by-word captions. */
function DemoVideo() {
  return (
    <div className="relative aspect-[9/16] w-[220px] overflow-hidden rounded-[22px] bg-[radial-gradient(120%_70%_at_75%_15%,#4a0b10_0%,#120607_55%,#050505_100%)] shadow-2xl ring-1 shadow-black/60 ring-white/10 sm:w-[250px]">
      {/* The logo's two circles: white, and red glass over it. */}
      <span className="lp-drift absolute top-[18%] left-[-12%] size-40 rounded-full bg-neutral-200/90" style={{ "--dx": "26px", "--dy": "18px" } as CSSProperties} />
      <span
        className="lp-drift absolute top-[12%] left-[22%] size-44 rounded-full bg-[#e5484d]/45 ring-1 ring-[#ff6b6b]/60 backdrop-blur-md"
        style={{ "--dx": "-22px", "--dy": "26px", animationDelay: "-5s" } as CSSProperties}
      />
      <span className="absolute inset-0 bg-[linear-gradient(180deg,transparent_45%,rgb(0_0_0/0.75)_100%)]" />

      {/* Scene 1 */}
      <div className="lp-loop lp-scene absolute inset-x-0 bottom-[30%] flex flex-col items-center" style={delay(0)}>
        <p className="flex gap-2 overflow-hidden text-[44px] leading-none font-extrabold tracking-tight text-white">
          <span className="lp-loop lp-word inline-block" style={delay(0.05)}>
            Say
          </span>
          <span className="lp-loop lp-word inline-block" style={delay(0.25)}>
            it.
          </span>
        </p>
      </div>

      {/* Scene 2 */}
      <div className="lp-loop lp-scene absolute inset-x-0 bottom-[28%] flex flex-col items-center gap-2" style={delay(SCENE_S)}>
        <p className="overflow-hidden text-[34px] leading-none font-extrabold tracking-tight text-white">
          <span className="lp-loop lp-word inline-block" style={delay(SCENE_S + 0.05)}>
            Watch it
          </span>
        </p>
        <span className="lp-loop lp-pop rounded-2xl bg-white/15 px-4 py-1.5 text-[38px] leading-none font-extrabold tracking-tight text-[#ff5a5f] ring-1 ring-white/25 backdrop-blur-md" style={delay(SCENE_S + 0.35)}>
          move.
        </span>
      </div>

      {/* Scene 3 */}
      <div className="lp-loop lp-scene absolute inset-x-4 bottom-[26%] flex flex-col gap-3 rounded-2xl bg-white/10 p-4 ring-1 ring-white/20 backdrop-blur-md" style={delay(SCENE_S * 2)}>
        <span className="text-[11px] font-semibold text-white/80">Synced to your voice</span>
        <span className="flex h-12 items-center gap-[3px]">
          {Array.from({ length: 22 }, (_, i) => (
            <span key={i} className="lp-wave h-full w-[4px] rounded-full bg-white/85" style={{ "--d": `${-(i * 0.13) % 1.1}s`, opacity: i % 5 === 2 ? 1 : 0.7 } as CSSProperties} />
          ))}
        </span>
        <span className="flex gap-1">
          {["beat", "on", "word"].map((w, i) => (
            <span key={w} className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${i === 2 ? "bg-[#e5484d] text-white" : "bg-white/15 text-white/80"}`}>
              {w}
            </span>
          ))}
        </span>
      </div>

      {/* Scene 4 */}
      <div className="lp-loop lp-scene absolute inset-x-0 bottom-[30%] flex flex-col items-center gap-3" style={delay(SCENE_S * 3)}>
        <img src="/brand/mark.png" alt="" className="lp-loop lp-pop h-16 w-auto rounded-2xl" style={delay(SCENE_S * 3 + 0.1)} />
        <span className="text-2xl font-extrabold tracking-tight text-white">
          motion<span className="text-[#e5484d]">i</span>ly
        </span>
      </div>

      {/* Captions */}
      {CAPTIONS.map((words, k) => (
        <p key={k} className="lp-loop lp-scene absolute inset-x-3 bottom-[9%] flex flex-wrap justify-center gap-x-1 text-[13px] font-bold" style={delay(k * SCENE_S)}>
          {words.map((w, i) => (
            <span key={i} className="lp-loop lp-cap rounded px-1" style={delay(k * SCENE_S + 0.1 + (i * (SCENE_S - 0.6)) / words.length)}>
              {w}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

/** The video's moments under the preview, with keyframes and the playhead running the loop. */
function DemoTimeline() {
  const moments = ["hook", "title", "voice", "logo"];
  const keys = [0.04, 0.11, 0.3, 0.37, 0.55, 0.62, 0.8, 0.88];
  return (
    <div className="relative w-full max-w-md select-none" aria-hidden>
      <div className="grid grid-cols-4 gap-1">
        {moments.map((m) => (
          <span key={m} className="truncate rounded-md bg-white/[0.06] px-2 py-1 text-[11px] text-neutral-400 ring-1 ring-white/5">
            {m}
          </span>
        ))}
      </div>
      <div className="relative mt-2 h-4">
        <span className="absolute inset-x-0 top-1/2 h-px bg-white/10" />
        {keys.map((k) => (
          <span key={k} className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-neutral-400" style={{ left: `${k * 100}%` }} />
        ))}
      </div>
      <span className="lp-play absolute -top-1 -bottom-1 w-px bg-[#e5484d]">
        <span className="absolute -top-1 -left-[3px] size-[7px] rounded-full bg-[#e5484d]" />
      </span>
    </div>
  );
}
