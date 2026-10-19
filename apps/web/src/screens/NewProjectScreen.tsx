import { useState } from "react";
import { VideoFormat } from "@motionily/protocol";
import { FormatPicker } from "../components/FormatPicker";
import { api } from "../api/client";
import { navigate, RouteName } from "../router";
import { requestAutoGenerate } from "../components/GeneratePanel";

/** A new video is just what to tell: the agent designs the whole look itself. */
export function NewProjectScreen({ brandId }: { brandId: string }) {
  const [brief, setBrief] = useState("");
  const [name, setName] = useState("");
  const [format, setFormat] = useState<VideoFormat>(VideoFormat.Vertical);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!brief.trim()) return;
    setBusy(true);
    try {
      const p = await api.createProject(name.trim() || brief.trim().slice(0, 40), brief.trim(), format, brandId);
      requestAutoGenerate(p.id);
      navigate({ name: RouteName.Editor, id: p.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-8 py-10">
      <div>
        <h1 className="text-2xl font-bold">Nuevo vídeo</h1>
        <p className="mt-1 text-sm text-neutral-400">Cuéntale a Claude qué quieres. Él decide el estilo, los colores, la tipografía y la animación; luego tú tocas lo que quieras clicando en el vídeo.</p>
      </div>
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={6}
          autoFocus
          placeholder="Ej.: reel de 15 s para Instagram: una fisio recibe a un paciente con dolor de espalda y con Clinily lo tiene todo en su ficha. Tono cercano, con humor."
          aria-label="¿De qué va el vídeo?"
          className="resize-y rounded-lg bg-neutral-900 px-4 py-3 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
        />
        <div className="max-w-sm">
          <FormatPicker value={format} onChange={setFormat} />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nombre (opcional)"
            aria-label="Nombre del vídeo"
            className="flex-1 rounded-lg bg-neutral-900 px-4 py-2.5 text-sm placeholder:text-neutral-600 focus:outline-none focus:ring-1 focus:ring-white/40"
          />
          <button type="submit" disabled={busy || !brief.trim()} className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900 hover:bg-neutral-200 disabled:opacity-50">
            Crear y generar
          </button>
        </div>
      </form>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </main>
  );
}
