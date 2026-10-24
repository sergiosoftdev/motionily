import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { desktop } from "./desktop";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {desktop?.error ? <RuntimeError message={desktop.error} /> : <App />}
  </StrictMode>,
);

/** The desktop app's local runtime (API) did not start: say why rather than show a broken editor. */
function RuntimeError({ message }: { message: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-950 p-8 text-neutral-200">
      <h1 className="text-lg font-semibold">Motionily could not start its local engine</h1>
      <pre className="max-w-3xl overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-900 p-4 text-xs text-neutral-400">{message}</pre>
    </main>
  );
}
