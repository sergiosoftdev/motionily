import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useSession } from "../session";
import { Logo } from "../components/Logo";
import { navigate, RouteName } from "../router";

/** Sign-in is simulated for now: any email gets an account (the API's mock Google login). */
export function useSignIn() {
  const login = useSession((s) => s.login);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signIn = async (email: string) => {
    if (!email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      login(await api.mockGoogle(email.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { signIn, busy, error };
}

/** Email + one button. `cta` is the button label; the hero and the closing band use it too. */
export function EmailStart({ cta, autoFocus = false, size = "lg" }: { cta: string; autoFocus?: boolean; size?: "lg" | "md" }) {
  const [email, setEmail] = useState("");
  const { signIn, busy, error } = useSignIn();
  const signedIn = !!useSession((s) => s.token);
  const tall = size === "lg" ? "h-12 text-[15px]" : "h-11 text-sm";
  if (signedIn)
    return (
      <button type="button" onClick={() => navigate({ name: RouteName.Projects })} className={`rounded-xl bg-white px-6 font-semibold text-neutral-950 transition hover:bg-neutral-200 ${tall}`}>
        Open your projects
      </button>
    );
  return (
    <form
      className="flex w-full max-w-md flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void signIn(email);
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          required
          autoFocus={autoFocus}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@company.com"
          aria-label="Email"
          className={`lp-glass w-full min-w-0 rounded-xl px-4 sm:flex-1 text-white placeholder:text-neutral-500 focus:ring-2 focus:ring-white/30 focus:outline-none ${tall}`}
        />
        <button type="submit" disabled={busy} className={`shrink-0 rounded-xl bg-white px-5 font-semibold text-neutral-950 transition hover:bg-neutral-200 disabled:opacity-60 ${tall}`}>
          {busy ? "Opening…" : cta}
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </form>
  );
}

/** The sign-in sheet over the landing. */
export function SignInDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="sign-in-title" className="lp-glass flex w-full max-w-sm flex-col items-center gap-6 rounded-3xl px-7 py-9 text-center" onClick={(e) => e.stopPropagation()}>
        <img src="/brand/mark.png" alt="" className="h-14 w-auto rounded-xl" />
        <div className="flex flex-col gap-1.5">
          <h2 id="sign-in-title" className="text-xl font-bold">
            Sign in to <Logo size="text-xl" />
          </h2>
          <p className="text-sm text-neutral-400">New here? Your account is created on the spot.</p>
        </div>
        <EmailStart cta="Continue" autoFocus size="md" />
        <p className="text-xs text-neutral-500">Sign-in is simulated during the beta: any email works.</p>
      </div>
    </div>
  );
}
