import { useState } from "react";
import { OpName, type Op } from "@motionily/protocol";
import { preview } from "../../../editing/direct";
import { engineHost } from "../../../engine/host";
import type { Anim } from "../keys";
import { AnimParam } from "./AnimParam";
import { EFFECTS, EffectCategory, effectDef, FX_ENABLED, newEffect, ParamKind, type Fx } from "./effects";
import { ColorField, Field, Line, rgbaHex, selectClass, Twirl } from "./fields";
import { notify } from "./notice";
import { tryOps } from "./scene";
import { ScrubNumber } from "../ScrubNumber";

/** Drag payload of an effect being reordered inside a stack. */
const REORDER_MIME = "application/x-motionily-fx-index";

/**
 * AE's per-layer effect stack in Effect Controls: + adds, × removes, drag reorders, the fx box
 * switches one off, and every animatable param has a stopwatch. Each change is one `patch` of the
 * layer's `effects`, the same op the agent sends.
 */
export function EffectStack({ id, layer, lt, fps }: { id: string; layer: Record<string, unknown>; lt: number; fps: number }) {
  const effects = (layer.effects as Fx[] | undefined) ?? [];
  const [over, setOver] = useState<number | null>(null);

  const write = (next: Fx[], done: boolean, what: string): string | null => {
    const op: Op = { op: OpName.Patch, id, fields: { effects: next.length ? next : null } };
    if (!done) {
      preview([op]);
      return null;
    }
    const err = tryOps([op], what);
    if (err) notify(err);
    return err;
  };
  const replace = (i: number, fx: Fx) => effects.map((e, j) => (j === i ? fx : e));

  const toggle = (i: number) => {
    const fx = effects[i]!;
    const off = fx[FX_ENABLED] !== false;
    const next = { ...fx, [FX_ENABLED]: off ? false : undefined };
    if (write(replace(i, next), true, `${off ? "Switches off" : "Switches on"} ${fx.fx} on ${id}`)) return;
    // The engine keeps only fields it knows: say so if this build can't switch effects off yet.
    const kept = (engineHost.layer(id)?.effects as Fx[] | undefined)?.[i];
    if (off && kept && kept[FX_ENABLED] !== false) notify("This engine build can't switch an effect off yet (needs `enabled` on effects).");
  };
  const drop = (from: number, to: number) => {
    if (from === to) return;
    const next = [...effects];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    write(next, true, `Moves ${moved!.fx} to position ${to + 1} on ${id}`);
  };

  return (
    <div className="flex flex-col">
      {effects.map((fx, i) => {
        const def = effectDef(fx.fx);
        const enabled = fx[FX_ENABLED] !== false;
        return (
          <div
            key={`${i}:${fx.fx}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(REORDER_MIME, String(i));
              e.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes(REORDER_MIME)) return;
              e.preventDefault();
              setOver(i);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              setOver(null);
              const from = Number(e.dataTransfer.getData(REORDER_MIME));
              if (Number.isInteger(from)) drop(from, i);
            }}
            className={over === i ? "border-t border-[#2d8ceb]" : "border-t border-transparent"}
          >
            <Twirl
              title={
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="cursor-grab text-[#5a5a5a]" title="Drag to reorder">
                    ⋮⋮
                  </span>
                  <span className={`truncate ${enabled ? "" : "text-[#8a8a8a] line-through"}`}>{def?.name ?? fx.fx}</span>
                </span>
              }
              aside={
                <>
                  <button
                    type="button"
                    onClick={() => toggle(i)}
                    title={enabled ? "Switch this effect off" : "Switch this effect on"}
                    className={`rounded-sm border px-0.5 text-[9px] leading-3 italic ${enabled ? "border-[#8a8a8a] text-[#c9c9c9]" : "border-[#444] text-[#555]"}`}
                  >
                    fx
                  </button>
                  <button type="button" onClick={() => write(effects.filter((_, j) => j !== i), true, `Removes ${def?.name ?? fx.fx} from ${id}`)} className="px-1 text-[#8a8a8a] hover:text-white" aria-label="Remove effect" title="Remove effect">
                    ×
                  </button>
                </>
              }
            >
              {def
                ? def.params.map((p) => {
                    const v = fx[p.key];
                    const set = (value: unknown, done: boolean) => write(replace(i, { ...fx, [p.key]: value ?? undefined }), done, `${def.name} ${p.label} on ${id}`);
                    switch (p.kind) {
                      case ParamKind.Anim:
                        return <AnimParam key={p.key} def={p} value={v as Anim | undefined} lt={lt} fps={fps} indent={22} sampled={{ id, path: `effects.${i}.${p.key}` }} onChange={(nv, done) => set(nv, done)} />;
                      case ParamKind.Fixed:
                        return (
                          <Line key={p.key} label={p.label} depth={1}>
                            <ScrubNumber value={typeof v === "number" ? v : (p.def as number)} step={p.step} decimals={p.decimals} unit={p.unit} min={p.min} max={p.max} onChange={(nv, done) => set(p.integer ? Math.round(nv) : nv, done)} />
                          </Line>
                        );
                      case ParamKind.Color:
                        return <ColorField key={p.key} name={p.label} depth={1} value={typeof v === "string" ? v : (rgbaHex(v) ?? undefined)} auto={p.def === undefined ? "auto" : undefined} onChange={set} />;
                      default:
                        return <Field key={p.key} name={p.label} value={v ?? p.def} depth={1} onChange={set} />;
                    }
                  })
                : Object.entries(fx)
                    .filter(([k]) => k !== "fx")
                    .map(([k, v]) => <Field key={k} name={k} value={v} depth={1} onChange={(nv, done) => write(replace(i, { ...fx, [k]: nv }), done, `${fx.fx} ${k} on ${id}`)} />)}
            </Twirl>
          </div>
        );
      })}
      <div className="px-3 pt-1">
        <select
          value=""
          onChange={(e) => {
            const def = effectDef(e.target.value);
            if (!def) return;
            const fields = def.adjustment ? { effects: [...effects, newEffect(def)], adjustment: true } : { effects: [...effects, newEffect(def)] };
            const err = tryOps([{ op: OpName.Patch, id, fields }], `Adds ${def.name} to ${id}`);
            if (err) notify(err);
          }}
          className={`${selectClass} w-full`}
          aria-label="Add an effect"
        >
          <option value="">+ Add Effect…</option>
          {Object.values(EffectCategory).map((c) => (
            <optgroup key={c} label={c}>
              {EFFECTS.filter((d) => d.category === c).map((d) => (
                <option key={d.kind} value={d.kind}>
                  {d.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    </div>
  );
}
