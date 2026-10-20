import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Logo } from "../components/Logo";
import { navigate, RouteName } from "../router";
import { useSession } from "../session";
import { HeroDemo } from "./HeroDemo";
import { EmailStart, SignInDialog } from "./SignIn";

const Section = { How: "how", Features: "features", Editors: "editors", Faq: "faq" } as const;
type Section = (typeof Section)[keyof typeof Section];
const NAV: [Section, string][] = [
  [Section.How, "How it works"],
  [Section.Features, "Features"],
  [Section.Editors, "Editors"],
  [Section.Faq, "FAQ"],
];

/** Scroll to a section without touching the URL hash (the app's router lives there). */
const goTo = (id: Section) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

/** Motionily's public page: what it is, how it works, and a mock sign-in to try it. */
export function LandingScreen() {
  const [signIn, setSignIn] = useState(false);
  const signedIn = !!useSession((s) => s.token);
  // Signed in (the page opened at #/welcome), every CTA opens the app.
  const start = () => (signedIn ? navigate({ name: RouteName.Projects }) : setSignIn(true));
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="min-h-dvh overflow-x-clip bg-black text-white">
      <header className={`fixed inset-x-0 top-0 z-40 transition ${scrolled ? "bg-black/60 backdrop-blur-xl" : ""}`}>
        <nav className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5 sm:px-8">
          <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} className="flex items-center gap-2.5" aria-label="Motionily, back to top">
            <img src="/brand/mark.png" alt="" className="h-8 w-auto rounded-lg" />
            <Logo size="text-lg" />
          </button>
          <div className="hidden items-center gap-6 text-sm text-neutral-400 md:flex">
            {NAV.map(([id, label]) => (
              <button key={id} type="button" onClick={() => goTo(id)} className="hover:text-white">
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {!signedIn && (
              <button type="button" onClick={start} className="hidden rounded-lg px-3 py-2 text-sm whitespace-nowrap text-neutral-300 hover:text-white sm:block">
                Sign in
              </button>
            )}
            <button type="button" onClick={start} className="rounded-lg bg-white px-4 py-2 text-sm font-semibold whitespace-nowrap text-neutral-950 hover:bg-neutral-200">
              {signedIn ? "Open Motionily" : "Start creating"}
            </button>
          </div>
        </nav>
      </header>

      <Hero />
      <HowItWorks />
      <Features />
      <Editors />
      <Faq />
      <Closing />

      <footer className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-5 py-10 text-sm text-neutral-500 sm:flex-row sm:px-8">
        <span className="flex items-center gap-2.5">
          <img src="/brand/mark.png" alt="" className="h-6 w-auto rounded-md" />
          <Logo size="text-base" />
        </span>
        <span>Rendered on your GPU by our own engine · © 2026 Motionily</span>
        <button type="button" onClick={start} className="hover:text-white">
          {signedIn ? "Open Motionily" : "Sign in"}
        </button>
      </footer>

      <SignInDialog open={signIn} onClose={() => setSignIn(false)} />
    </div>
  );
}

/** The two circles of the logo, huge and blurred, behind a section. */
function Orbs({ className = "" }: { className?: string }) {
  return (
    <div className={`pointer-events-none absolute inset-0 -z-10 overflow-hidden ${className}`} aria-hidden>
      <span className="lp-drift absolute top-[-12%] left-[8%] size-[520px] rounded-full bg-white/[0.07] blur-[110px]" style={{ "--dx": "60px", "--dy": "40px" } as CSSProperties} />
      <span className="lp-drift absolute top-[-6%] right-[4%] size-[560px] rounded-full bg-[#e5484d]/25 blur-[120px]" style={{ "--dx": "-50px", "--dy": "50px", animationDelay: "-6s" } as CSSProperties} />
    </div>
  );
}

function Hero() {
  return (
    <section className="relative isolate px-5 pt-32 pb-20 sm:px-8 sm:pt-40">
      <Orbs />
      <div className="mx-auto flex max-w-6xl flex-col items-center text-center">
        <span className="lp-glass mb-7 flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs text-neutral-300">
          <span className="size-1.5 rounded-full bg-[#e5484d]" /> Now in beta · Powered by Claude
        </span>
        <h1 className="max-w-4xl text-5xl leading-[1.02] font-extrabold tracking-tight sm:text-7xl">
          Motion graphics,
          <br />
          <span className="bg-[linear-gradient(100deg,#ffffff_10%,#f6a5a5_55%,#e5484d_95%)] bg-clip-text text-transparent">directed by AI.</span>
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-neutral-400">
          Write what you want to say. Claude scripts it, designs every scene and times each beat to your voice. Then you refine anything with a click.
        </p>
        <div className="mt-9 flex w-full flex-col items-center gap-3">
          <EmailStart cta="Start creating" />
          <span className="text-xs text-neutral-500">No credit card · Runs in your browser</span>
        </div>
      </div>
      <div className="mx-auto mt-16 max-w-5xl">
        <HeroDemo />
      </div>
    </section>
  );
}

function Heading({ id, eyebrow, title, children }: { id: Section; eyebrow: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div id={id} className="mx-auto flex max-w-3xl scroll-mt-24 flex-col items-center gap-4 text-center">
      <span className="text-sm font-medium text-[#f07575]">{eyebrow}</span>
      <h2 className="text-4xl leading-[1.08] font-bold tracking-tight sm:text-5xl">{title}</h2>
      {children && <p className="text-lg leading-relaxed text-neutral-400">{children}</p>}
    </div>
  );
}

const STEPS: { title: string; body: string }[] = [
  { title: "Write what you want to say", body: "Your idea in your own words, with references if you have them. Claude proposes angles and writes the script in natural, spoken English." },
  { title: "Add your voice", body: "Upload the voice-over. Motionily transcribes it word by word in your browser, so captions, cuts and pauses land on your words." },
  { title: "Claude directs the video", body: "A team of agents designs each scene, animates it to the voice and checks its own frames. You watch it build, live." },
  { title: "Refine and export", body: "Click anything and ask for a change, or open Pro mode for keyframes. Export an MP4 rendered frame by frame on your GPU." },
];

function HowItWorks() {
  return (
    <section className="px-5 py-24 sm:px-8">
      <Heading id={Section.How} eyebrow="How it works" title="From one sentence to a finished video" />
      <ol className="mx-auto mt-16 grid max-w-6xl gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="lp-glass flex flex-col gap-4 rounded-3xl p-6">
            <span className="flex size-9 items-center justify-center rounded-full bg-white text-sm font-bold text-neutral-950">{i + 1}</span>
            <h3 className="text-lg font-semibold">{s.title}</h3>
            <p className="text-sm leading-relaxed text-neutral-400">{s.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Card({ title, body, children, className = "" }: { title: string; body: string; children: ReactNode; className?: string }) {
  return (
    <div className={`lp-glass flex flex-col gap-6 overflow-hidden rounded-3xl p-6 sm:p-7 ${className}`}>
      <div className="flex min-h-36 flex-1 items-center justify-center">{children}</div>
      <div className="flex flex-col gap-2">
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-sm leading-relaxed text-neutral-400">{body}</p>
      </div>
    </div>
  );
}

function Features() {
  return (
    <section className="relative isolate px-5 py-24 sm:px-8">
      <Heading id={Section.Features} eyebrow="Features" title="A real motion engine, with an AI director">
        Not templates or slideshows: every frame is drawn by an engine built for motion design, and every decision is made by Claude.
      </Heading>
      <div className="mx-auto mt-16 grid max-w-6xl gap-4 md:grid-cols-3">
        <Card
          className="md:col-span-2"
          title="Our own render engine, built from scratch"
          body="Written in Rust and compiled to WebAssembly, it draws every frame on your graphics card through WebGPU: a live preview while Claude works, and a frame-exact MP4 when you export."
        >
          <div className="flex w-full max-w-lg flex-wrap items-center justify-center gap-2 sm:flex-nowrap">
            {["Rust", "WebAssembly", "WebGPU", "MP4"].map((s, i) => (
              <span key={s} className="flex items-center gap-2">
                {i > 0 && <span className="lp-flow hidden h-px w-10 bg-[linear-gradient(90deg,transparent,#e5484d,transparent)] sm:block" />}
                <span className={`rounded-xl px-3.5 py-2 text-sm font-semibold ring-1 ${i === 2 ? "bg-[#e5484d]/20 text-white ring-[#e5484d]/50" : "bg-white/5 text-neutral-200 ring-white/10"}`}>{s}</span>
              </span>
            ))}
          </div>
        </Card>
        <Card title="Real camera, real depth" body="Camera moves, parallax, lighting and extruded 3D text. Scenes have space, not flat slides.">
          <div className="relative h-36 w-40 [perspective:600px]" aria-hidden>
            <div className="lp-spin3d absolute inset-0 [transform-style:preserve-3d]">
              <span className="absolute inset-0 rounded-2xl bg-white/10 ring-1 ring-white/20 [transform:translateZ(-30px)]" />
              <span className="absolute inset-4 rounded-xl bg-[#e5484d]/35 ring-1 ring-[#ff6b6b]/50 [transform:translateZ(10px)]" />
              <span className="absolute inset-9 rounded-lg bg-white/80 [transform:translateZ(50px)]" />
            </div>
          </div>
        </Card>
        <Card title="Timed to your words" body="Every beat lands on a word and long pauses become cuts. Captions come word by word, styled to match.">
          <div className="flex flex-col items-center gap-3" aria-hidden>
            <span className="flex h-14 items-center gap-[3px]">
              {[0.3, 0.6, 0.9, 0.5, 0.75, 1, 0.4, 0.2, 0.55, 0.85, 0.65, 0.3, 0.7, 0.95, 0.45, 0.25].map((h, i) => (
                <span key={i} className="w-1 rounded-full bg-white/70" style={{ height: `${h * 100}%` }} />
              ))}
            </span>
            <span className="flex gap-1 text-xs font-semibold">
              <span className="rounded-md bg-white/10 px-2 py-0.5">every</span>
              <span className="rounded-md bg-[#e5484d] px-2 py-0.5">beat</span>
              <span className="rounded-md bg-white/10 px-2 py-0.5">lands</span>
            </span>
          </div>
        </Card>
        <Card title="Your brand, every video" body="Logos, palettes and fonts live in your brand kit, so every video looks like yours without asking twice.">
          <div className="flex items-center gap-4" aria-hidden>
            <span className="flex -space-x-3">
              {["#ffffff", "#f07575", "#e5484d", "#7a0000"].map((c) => (
                <span key={c} className="size-11 rounded-full ring-4 ring-black" style={{ background: c }} />
              ))}
            </span>
            <span className="text-4xl font-extrabold tracking-tight">Aa</span>
          </div>
        </Card>
        <Card title="Every format" body="Vertical, portrait, square or wide. Switch it and Claude recomposes every scene for the new frame.">
          <div className="flex items-end gap-3" aria-hidden>
            {[
              ["9:16", "h-20 w-[45px]"],
              ["4:5", "h-[70px] w-14"],
              ["1:1", "size-14"],
              ["16:9", "h-[45px] w-20"],
            ].map(([label, box]) => (
              <span key={label} className="flex flex-col items-center gap-2">
                <span className={`rounded-lg ring-2 ring-white/40 ${box}`} />
                <span className="text-xs text-neutral-400">{label}</span>
              </span>
            ))}
          </div>
        </Card>
        <Card className="md:col-span-3" title="Works with Claude Code" body="Prefer your own agent? Connect Claude Code to Motionily over MCP with one command and watch it build the video in the editor, live.">
          <div className="w-full max-w-2xl rounded-2xl bg-black/70 p-4 font-mono text-[12px] leading-relaxed ring-1 ring-white/10 sm:text-[13px]">
            <p className="truncate text-neutral-500">$ claude mcp add motionily -e MOTIONILY_PROJECT=… -- motionily-mcp</p>
            <p className="mt-1 text-neutral-200">
              $ claude <span className="text-[#f6a5a5]">"Build the video for my Motionily project"</span>
            </p>
            <p className="mt-1 text-emerald-300/80">● Building 6 scenes, timed to your voice…</p>
          </div>
        </Card>
      </div>
    </section>
  );
}

function Editors() {
  return (
    <section className="px-5 py-24 sm:px-8">
      <Heading id={Section.Editors} eyebrow="Two editors" title="Simple when you want it fast. Pro when you want control." />
      <div className="mx-auto mt-16 grid max-w-6xl gap-4 md:grid-cols-2">
        <div className="lp-glass flex flex-col gap-6 rounded-3xl p-6 sm:p-8">
          <div className="flex flex-1 items-end justify-center gap-4 rounded-2xl bg-black/50 px-4 pt-8 pb-5" aria-hidden>
            <div className="relative flex aspect-[9/16] w-28 flex-col items-center justify-center rounded-xl bg-[radial-gradient(120%_70%_at_70%_15%,#4a0b10,#0b0505)] ring-1 ring-white/10">
              <span className="text-xl font-extrabold">Watch it</span>
              <span className="relative mt-1 text-xl font-extrabold text-[#ff5a5f]">
                move.
                <span className="absolute -inset-1.5 rounded-md ring-2 ring-sky-400" />
              </span>
            </div>
            <div className="flex w-52 flex-col gap-2 pb-1">
              <span className="self-start rounded-full bg-sky-400/15 px-2 py-0.5 text-[11px] text-sky-200">move. · 0:04</span>
              <span className="rounded-xl bg-white/[0.06] px-3 py-2 text-xs text-neutral-200 ring-1 ring-white/10">Bigger, and bounce it in</span>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-semibold">Simple: watch, click, ask</h3>
            <p className="text-sm leading-relaxed text-neutral-400">
              The video and one box. Click any element, pick a moment or talk about the whole video: “bigger”, “warmer colors”, “faster pace”. The agent changes just that.
            </p>
          </div>
        </div>
        <div className="lp-glass flex flex-col gap-6 rounded-3xl p-6 sm:p-8">
          <div className="flex flex-1 flex-col gap-1.5 rounded-2xl bg-[#1d1d1d] p-4 text-[11px] text-[#c9c9c9]" aria-hidden>
            <div className="flex items-center gap-3 pb-1">
              <span className="text-base text-[#4aa3f0] tabular-nums">0:00:05:12</span>
              <span className="text-[#8a8a8a]">30 fps</span>
            </div>
            <div className="relative flex flex-col gap-1.5">
            {[
              ["#b53838", "T", "title", 8, 55, [12, 30]],
              ["#677de0", "★", "card", 20, 70, [24, 48, 62]],
              ["#8e2c9a", "▣", "hook", 0, 40, []],
              ["#e7c19e", "◆", "phone", 30, 85, [34, 52, 78]],
              ["#f46dd6", "ƒ", "glow", 45, 100, [50]],
              ["#a9cbc7", "▶", "clip", 35, 95, [40]],
            ].map(([color, icon, name, a, b, keys]) => (
              <div key={name as string} className="flex h-6 items-center gap-2 rounded-sm bg-[#262626] pr-2">
                <span className="ml-2 size-2 rounded-[2px]" style={{ background: color as string }} />
                <span className="w-3 text-[#8a8a8a]">{icon}</span>
                <span className="w-12">{name}</span>
                <span className="relative h-full flex-1">
                  <span className="absolute inset-y-[5px] rounded-[2px] opacity-60" style={{ left: `${a}%`, width: `${(b as number) - (a as number)}%`, background: color as string }} />
                  {(keys as number[]).map((k) => (
                    <span key={k} className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-[#d0d0d0]" style={{ left: `${k}%` }} />
                  ))}
                </span>
              </div>
            ))}
            <span className="absolute -top-1 -bottom-1 w-px bg-[#e5484d]" style={{ left: "calc(5.5rem + (100% - 6rem) * 0.42)" }} />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-xl font-semibold">Pro: an After Effects-style timeline</h3>
            <p className="text-sm leading-relaxed text-neutral-400">
              Layers, stopwatches, keyframes you can drag, blend modes and every property editable. The agent stays one box away when you want it.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

const QUESTIONS: [string, string][] = [
  ["Do I need to know animation?", "No. You write what you want to say and Claude designs, animates and times the video. Pro mode is there when you want to move keyframes yourself."],
  ["What do I get at the end?", "An MP4 up to 1080p in 9:16, 4:5, 1:1 or 16:9, rendered frame by frame on your GPU with your voice-over and sound effects mixed in."],
  ["Where does it run?", "In your browser. The engine runs on your graphics card through WebGPU, so a recent Chrome or Edge works best."],
  ["Which AI makes the videos?", "Claude, by Anthropic. A small team of Claude agents writes the script, designs and builds each scene, and reviews its own frames before you see them."],
];

function Faq() {
  return (
    <section className="px-5 py-24 sm:px-8">
      <Heading id={Section.Faq} eyebrow="FAQ" title="Questions, answered" />
      <div className="mx-auto mt-12 flex max-w-3xl flex-col gap-3">
        {QUESTIONS.map(([q, a]) => (
          <details key={q} className="lp-glass group rounded-2xl px-6 py-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-semibold">
              {q}
              <span className="text-xl text-neutral-500 transition group-open:rotate-45">+</span>
            </summary>
            <p className="mt-3 text-sm leading-relaxed text-neutral-400">{a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className="px-5 py-24 sm:px-8">
      <div className="lp-glass relative isolate mx-auto flex max-w-5xl flex-col items-center gap-6 overflow-hidden rounded-[32px] px-6 py-16 text-center sm:py-20">
        <Orbs />
        <img src="/brand/mark.png" alt="" className="h-16 w-auto rounded-2xl" />
        <h2 className="max-w-2xl text-4xl leading-[1.08] font-bold tracking-tight sm:text-5xl">Your next video starts with one sentence.</h2>
        <p className="max-w-xl text-lg text-neutral-400">Sign in, write your idea and watch Claude build it.</p>
        <EmailStart cta="Start creating" />
      </div>
    </section>
  );
}
