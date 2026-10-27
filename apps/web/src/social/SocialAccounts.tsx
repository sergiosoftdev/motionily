import { useEffect, useState } from "react";
import { SOCIAL_LABEL, SocialPlatform, type SocialAccount } from "@motionily/protocol";
import { api } from "../api/client";

/** While Google's login is open in another tab, check this often whether it came back. */
const POLL_MS = 3000;
const POLL_FOR_MS = 5 * 60_000;

const input =
  "min-w-0 flex-1 rounded-lg bg-neutral-900 px-3 py-2 font-mono text-sm placeholder:font-sans placeholder:text-neutral-600 focus:ring-1 focus:ring-white/30 focus:outline-none";
const primary = "shrink-0 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-40";
const help = "text-xs leading-relaxed text-neutral-500";

/**
 * Instagram, TikTok and YouTube, each through the user's own developer app (Motionily ships no shared
 * app): the numbers of every video posted from the calendar come back from here.
 */
export function SocialAccounts() {
  const [accounts, setAccounts] = useState<SocialAccount[] | null>(null);
  const [redirect, setRedirect] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const load = () =>
    api.socialAccounts().then(
      (r) => {
        setAccounts(r.accounts);
        setRedirect(r.youtubeRedirect);
        return r.accounts;
      },
      (e: Error) => {
        setError(e.message);
        return null;
      },
    );
  useEffect(() => void load(), []);

  const run = async (fn: () => Promise<SocialAccount[]>) => {
    setError(null);
    try {
      setAccounts(await fn());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  };
  const sync = async () => {
    setSyncing("Fetching…");
    try {
      const r = await api.syncSocial();
      setSyncing(r.errors.length ? r.errors.join(" · ") : `Updated ${r.synced} posted ${r.synced === 1 ? "video" : "videos"}.`);
      void load();
    } catch (e) {
      setSyncing(e instanceof Error ? e.message : String(e));
    }
  };

  if (!accounts) return <p className="text-xs text-neutral-500">{error ?? "Loading…"}</p>;
  const of = (p: SocialPlatform) => accounts.find((a) => a.platform === p)!;
  return (
    <div className="flex flex-col gap-5">
      <Account account={of(SocialPlatform.Instagram)} onDisconnect={() => run(() => api.disconnectSocial(SocialPlatform.Instagram))}>
        <InstagramForm onConnect={(token) => run(() => api.connectInstagram(token))} />
      </Account>
      <Account account={of(SocialPlatform.TikTok)} onDisconnect={() => run(() => api.disconnectSocial(SocialPlatform.TikTok))}>
        <TikTokForm onFinish={(url) => run(() => api.finishTikTok(url))} onError={setError} />
      </Account>
      <Account account={of(SocialPlatform.YouTube)} onDisconnect={() => run(() => api.disconnectSocial(SocialPlatform.YouTube))}>
        <YouTubeForm redirect={redirect} onError={setError} poll={async () => (await load())?.find((a) => a.platform === SocialPlatform.YouTube)?.connected ?? false} />
      </Account>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {accounts.some((a) => a.connected) && (
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => void sync()} className="shrink-0 rounded-lg bg-neutral-800 px-3 py-2 text-xs font-semibold whitespace-nowrap hover:bg-neutral-700">
            Refresh numbers now
          </button>
          <span className="text-xs text-neutral-500">{syncing ?? "Videos you mark as posted are matched and measured every 6 hours for 90 days."}</span>
        </div>
      )}
    </div>
  );
}

function Account({ account, onDisconnect, children }: { account: SocialAccount; onDisconnect: () => void; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-sm">
        <span className={`size-2 rounded-full ${account.connected ? "bg-emerald-400" : account.error ? "bg-amber-400" : "bg-neutral-700"}`} />
        {SOCIAL_LABEL[account.platform]}
        {account.connected && <span className="text-neutral-400">· {account.handle || "connected"}</span>}
        {(account.connected || account.error) && (
          <button type="button" onClick={onDisconnect} className="ml-auto text-xs text-neutral-500 hover:text-white">
            Disconnect
          </button>
        )}
      </h3>
      {account.error && <p className="text-xs text-amber-200/90">{account.error}</p>}
      {!account.connected && children}
    </div>
  );
}

/** The app's secret (32 hex characters, shown next to the app id) is the usual wrong paste: tokens are far longer. */
const looksLikeAppSecret = (s: string) => /^[0-9a-f]{32}$/i.test(s.trim());

function InstagramForm({ onConnect }: { onConnect: (token: string) => Promise<boolean> }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const secret = looksLikeAppSecret(token);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void onConnect(token.trim()).then((ok) => {
          setBusy(false);
          if (ok) setToken("");
        });
      }}
    >
      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Access token (IGAA…)"
          autoComplete="off"
          spellCheck={false}
          aria-label="Instagram access token"
          className={input}
        />
        <button type="submit" disabled={busy || secret || token.trim().length < 20} className={primary}>
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>
      {secret && (
        <p className="text-xs text-amber-300">
          That is the app's secret, not an access token. The token is much longer and starts with IGAA: in the app's Instagram API setup, under "Generate access tokens", press
          Generate token next to the account and paste what it shows.
        </p>
      )}
      <p className={help}>
        A professional (Business or Creator) account. In developers.facebook.com create an app with the Instagram API use case, add the account as an Instagram tester, accept it in
        the Instagram app, then press Generate token and paste it here. It is refreshed before its 60 days run out.
      </p>
    </form>
  );
}

function TikTokForm({ onFinish, onError }: { onFinish: (url: string) => Promise<boolean>; onError: (e: string) => void }) {
  const [app, setApp] = useState({
    clientKey: "",
    clientSecret: "",
    redirectUri: "",
  });
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [back, setBack] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      setAuthorizeUrl((await api.startTikTok(app)).authorizeUrl);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (authorizeUrl)
    return (
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void onFinish(back).then(() => setBusy(false));
        }}
      >
        <a href={authorizeUrl} target="_blank" rel="noreferrer" className="self-start text-sm font-semibold text-white underline">
          1 · Log in with TikTok and allow access
        </a>
        <div className="flex gap-2">
          <input
            value={back}
            onChange={(e) => setBack(e.target.value)}
            placeholder="2 · Paste the address TikTok sent you to"
            spellCheck={false}
            aria-label="Address TikTok redirected to"
            className={input}
          />
          <button type="submit" disabled={busy || !back.trim()} className={primary}>
            {busy ? "Connecting…" : "Finish"}
          </button>
        </div>
        <button type="button" onClick={() => setAuthorizeUrl(null)} className="self-start text-xs text-neutral-500 hover:text-white">
          Change the app
        </button>
      </form>
    );
  const field = (k: keyof typeof app, placeholder: string, secret = false) => (
    <input
      type={secret ? "password" : "text"}
      value={app[k]}
      onChange={(e) => setApp({ ...app, [k]: e.target.value })}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      aria-label={placeholder}
      className={input}
    />
  );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <div className="flex gap-2">
        {field("clientKey", "Client key")}
        {field("clientSecret", "Client secret", true)}
      </div>
      <div className="flex gap-2">
        {field("redirectUri", "Redirect URI (https://…)")}
        <button type="submit" disabled={busy || !app.clientKey || !app.clientSecret || !app.redirectUri.startsWith("http")} className={primary}>
          Next
        </button>
      </div>
      <p className={help}>
        In developers.tiktok.com create an app, add Login Kit (Web) with an https Redirect URI you own and the Display API with the user.info.basic and video.list scopes. While the
        app is in Sandbox, add your account under Target users. TikTok sends you to that address after you allow access: paste it back here.
      </p>
    </form>
  );
}

function YouTubeForm({ redirect, onError, poll }: { redirect: string; onError: (e: string) => void; poll: () => Promise<boolean> }) {
  const [app, setApp] = useState({ clientId: "", clientSecret: "" });
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Google redirects to the API in another tab; this one notices when the account shows up.
  useEffect(() => {
    if (!authorizeUrl) return;
    const until = Date.now() + POLL_FOR_MS;
    const id = setInterval(() => {
      if (Date.now() > until) return clearInterval(id);
      void poll().then((done) => done && clearInterval(id));
    }, POLL_MS);
    return () => clearInterval(id);
  }, [authorizeUrl]); // eslint-disable-line react-hooks/exhaustive-deps
  const start = async () => {
    setBusy(true);
    try {
      setAuthorizeUrl((await api.startYouTube(app)).authorizeUrl);
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (authorizeUrl)
    return (
      <div className="flex flex-col gap-2">
        <a href={authorizeUrl} target="_blank" rel="noreferrer" className="self-start text-sm font-semibold text-white underline">
          Log in with Google and allow access
        </a>
        <p className={help}>This page updates by itself once Google sends you back.</p>
        <button type="button" onClick={() => setAuthorizeUrl(null)} className="self-start text-xs text-neutral-500 hover:text-white">
          Change the client
        </button>
      </div>
    );
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <div className="flex gap-2">
        <input
          value={app.clientId}
          onChange={(e) => setApp({ ...app, clientId: e.target.value })}
          placeholder="OAuth client ID"
          autoComplete="off"
          spellCheck={false}
          aria-label="Google OAuth client ID"
          className={input}
        />
        <input
          type="password"
          value={app.clientSecret}
          onChange={(e) => setApp({ ...app, clientSecret: e.target.value })}
          placeholder="Client secret"
          autoComplete="off"
          spellCheck={false}
          aria-label="Google OAuth client secret"
          className={input}
        />
        <button type="submit" disabled={busy || app.clientId.length < 10 || !app.clientSecret} className={primary}>
          Next
        </button>
      </div>
      <p className={help}>
        In console.cloud.google.com enable the YouTube Data API v3 and the YouTube Analytics API, then create an OAuth client (Web application) with this redirect URI:{" "}
        <code className="break-all text-neutral-300">{redirect}</code>. While the consent screen is in Testing, add your Google account as a test user.
      </p>
    </form>
  );
}
