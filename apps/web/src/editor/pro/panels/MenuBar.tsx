import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { engineHost } from "../../../engine/host";
import { useEditor } from "../../../store";
import { isExpr } from "../keys";
import { duplicateLayer, splitLayerAtPlayhead } from "../layerActions";
import { setProp } from "../keys";
import {
  addLayerStyle,
  addEffect,
  addAnimation,
  addNewLayer,
  focalPx,
  hasCamera,
  layerAbove,
  LayerSwitch,
  NewLayer,
  precompose,
  removeAllEffects,
  setBlend,
  setMatte,
  toggleSwitch,
} from "./actions";
import { exprFrom } from "./AnimParam";
import { BLEND_BREAKS, BLEND_MODES, DEFAULT_LENS_MM, EFFECTS, EffectCategory, LAYER_STYLES, LENSES, MATTE_MODES, NORMAL_BLEND, type Matte } from "./effects";
import { clearNotice, notify, NoticeKind, useNotice } from "./notice";
import { needSelection, readScene, runOps, selectedIds } from "./scene";
import { DialogKind, LeftTab, openDialog, RightTab, setLeft, setRight, toggleTool, ToolTab, useWorkspace } from "./workspace";

const Entry = { Item: "item", Sub: "sub", Separator: "separator" } as const;
type MenuItem =
  | { kind: typeof Entry.Item; label: string; shortcut?: string; checked?: boolean; disabled?: boolean; run: () => void }
  | { kind: typeof Entry.Sub; label: string; items: MenuItem[]; disabled?: boolean }
  | { kind: typeof Entry.Separator };

const item = (label: string, run: () => void, o: { shortcut?: string; checked?: boolean; disabled?: boolean } = {}): MenuItem => ({ kind: Entry.Item, label, run, ...o });
const sub = (label: string, items: MenuItem[], disabled = false): MenuItem => ({ kind: Entry.Sub, label, items, disabled: disabled || !items.length });
const SEP: MenuItem = { kind: Entry.Separator };

const MenuName = { Layer: "Layer", Effect: "Effect", Animation: "Animation", Window: "Window" } as const;
type MenuName = (typeof MenuName)[keyof typeof MenuName];

/** Shortcut labels, AE's. */
const Keys = {
  Text: "⌥⇧⌘T",
  Solid: "⌘Y",
  Null: "⌥⇧⌘Y",
  Adjustment: "⌥⌘Y",
  Camera: "⌥⇧⌘C",
  Precompose: "⇧⌘C",
  Duplicate: "⌘D",
  Split: "⇧⌘D",
  Expression: "⌥⇧=",
} as const;

/** Animation > Add Expression: the property last clicked in Effect Controls gets a formula (its value). */
export function addExpressionToFocused() {
  const prop = useWorkspace.getState().prop;
  const layer = prop && engineHost.layer(prop.id);
  if (!prop || !layer) return notify("Click a property's name in Effect Controls first, then add the expression.");
  const values = engineHost.propValues(prop.id) ?? {};
  const ops = prop.props.filter((p) => !isExpr(layer[p])).map((p) => setProp(prop.id, p, exprFrom(values[p] ?? 0)));
  if (!ops.length) return notify(`${prop.label} already has an expression.`, NoticeKind.Info);
  if (runOps(ops, `Adds an expression to ${prop.label} of ${prop.id}`)) {
    useEditor.setState({ selectedLayerId: prop.id, selectedGroup: null });
    setLeft(LeftTab.Controls);
  }
}

function withSelection(what: string, fn: (ids: string[]) => void) {
  return () => {
    const ids = selectedIds();
    if (needSelection(ids, what)) fn(ids);
  };
}

const openPrecompose = () => needSelection(selectedIds(), "pre-compose") && openDialog(DialogKind.Precompose);

/** AE's shortcuts for the menu items (Pro mode only, never while typing). */
function useMenuShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable='true']")) return;
      const cmd = e.metaKey || e.ctrlKey;
      const combo = `${cmd ? "c" : ""}${e.altKey ? "a" : ""}${e.shiftKey ? "s" : ""}:${e.code}`;
      const actions: Record<string, () => unknown> = {
        "cas:KeyT": () => addNewLayer(NewLayer.Text),
        "c:KeyY": () => openDialog(DialogKind.Solid),
        "cas:KeyY": () => addNewLayer(NewLayer.Null),
        "ca:KeyY": () => addNewLayer(NewLayer.Adjustment),
        "cas:KeyC": () => openDialog(DialogKind.Camera),
        "cs:KeyC": openPrecompose,
        "as:Equal": addExpressionToFocused,
      };
      const run = actions[combo];
      if (!run) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      run();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}

function buildMenus(): Record<MenuName, MenuItem[]> {
  const ids = selectedIds();
  const none = ids.length === 0;
  const first = ids[0] ? engineHost.layer(ids[0]) : undefined;
  const on = (sw: LayerSwitch) => !none && ids.every((id) => engineHost.layer(id)?.[sw] === true);
  const blend = (first?.blend as string | undefined) ?? NORMAL_BLEND;
  const matte = first?.matte as Matte | undefined;
  const above = ids[0] ? layerAbove(ids[0]) : undefined;
  const anims = Object.keys(readScene()?.library?.animations ?? {});
  const { left, right, tool } = useWorkspace.getState();
  return {
    [MenuName.Layer]: [
      sub("New", [
        item("Text", () => addNewLayer(NewLayer.Text), { shortcut: Keys.Text }),
        item("Solid…", () => openDialog(DialogKind.Solid), { shortcut: Keys.Solid }),
        item("Shape Layer", () => addNewLayer(NewLayer.Shape)),
        item("Null Object", () => addNewLayer(NewLayer.Null), { shortcut: Keys.Null }),
        item("Adjustment Layer", () => addNewLayer(NewLayer.Adjustment), { shortcut: Keys.Adjustment }),
        item("Camera…", () => openDialog(DialogKind.Camera), { shortcut: Keys.Camera }),
      ]),
      SEP,
      item("Pre-compose…", openPrecompose, { shortcut: Keys.Precompose, disabled: none }),
      item("Duplicate", () => duplicateLayer(ids), { shortcut: Keys.Duplicate, disabled: none }),
      item("Split Layer", () => splitLayerAtPlayhead(ids), { shortcut: Keys.Split, disabled: none }),
      SEP,
      item("Solo", () => toggleSwitch(ids, LayerSwitch.Solo), { checked: on(LayerSwitch.Solo), disabled: none }),
      item("Lock", () => toggleSwitch(ids, LayerSwitch.Locked), { checked: on(LayerSwitch.Locked), disabled: none }),
      item("Shy", () => toggleSwitch(ids, LayerSwitch.Shy), { checked: on(LayerSwitch.Shy), disabled: none }),
      SEP,
      sub(
        "Blending Mode",
        BLEND_MODES.flatMap(([m, label]) => [...(BLEND_BREAKS.has(m) ? [SEP] : []), item(label, () => setBlend(ids, m), { checked: blend === m })]),
        none,
      ),
      sub(
        "Track Matte",
        [
          item("No Track Matte", () => setMatte(ids[0]!, null), { checked: !matte }),
          SEP,
          ...MATTE_MODES.map(([m, label]) =>
            item(`${label} "${matte?.layer ?? above ?? "—"}"`, () => setMatte(ids[0]!, matte?.layer ?? above ?? null, m), { checked: matte?.mode === m || (!!matte && !matte.mode && m === MATTE_MODES[0]![0]), disabled: !matte && !above }),
          ),
        ],
        ids.length !== 1,
      ),
    ],
    [MenuName.Effect]: [
      item("Remove All", withSelection("remove its effects", removeAllEffects), { disabled: none }),
      SEP,
      ...Object.values(EffectCategory).map((c) =>
        sub(
          c,
          EFFECTS.filter((d) => d.category === c).map((d) => item(d.name, withSelection("apply an effect", (s) => addEffect(s, d)))),
        ),
      ),
      sub(
        "Layer Styles",
        LAYER_STYLES.map((st) => item(st.name, withSelection("apply a layer style", (s) => addLayerStyle(s, st)))),
      ),
    ],
    [MenuName.Animation]: [
      item("Add Expression", addExpressionToFocused, { shortcut: Keys.Expression }),
      sub(
        "Apply Animation",
        anims.map((a) => item(a, withSelection("animate", (s) => addAnimation(s, a)))),
        none,
      ),
      item("Browse Presets…", () => setRight(RightTab.Effects)),
    ],
    [MenuName.Window]: [
      item("Effect Controls", () => setLeft(LeftTab.Controls), { checked: left === LeftTab.Controls }),
      item("Project", () => setLeft(LeftTab.Project), { checked: left === LeftTab.Project }),
      SEP,
      item("Agent", () => setRight(RightTab.Agent), { checked: right === RightTab.Agent }),
      item("Activity", () => setRight(RightTab.Activity), { checked: right === RightTab.Activity }),
      item("Effects & Presets", () => setRight(RightTab.Effects), { checked: right === RightTab.Effects }),
      SEP,
      item("Character", () => toggleTool(ToolTab.Character), { checked: tool === ToolTab.Character }),
      item("Paragraph", () => toggleTool(ToolTab.Paragraph), { checked: tool === ToolTab.Paragraph }),
      item("Align", () => toggleTool(ToolTab.Align), { checked: tool === ToolTab.Align }),
    ],
  };
}

function MenuList({ items, close, style }: { items: MenuItem[]; close: () => void; style?: React.CSSProperties }) {
  return (
    <div style={style} className="min-w-52 rounded-[3px] border border-[#111] bg-[#2b2b2b] py-1 text-[12px] text-[#d6d6d6] shadow-xl shadow-black/50">
      {items.map((it, i) => {
        if (it.kind === Entry.Separator) return <div key={i} className="my-1 h-px bg-[#3a3a3a]" />;
        const row = "flex h-6 w-full items-center gap-2 px-2 text-left disabled:text-[#666]";
        if (it.kind === Entry.Sub)
          return (
            <div key={i} className="group/sub relative">
              <button type="button" disabled={it.disabled} className={`${row} enabled:hover:bg-[#2d8ceb] enabled:hover:text-white`}>
                <span className="w-3" />
                <span className="flex-1">{it.label}</span>
                <span className="text-[9px]">▶</span>
              </button>
              {!it.disabled && (
                <div className="absolute top-[-5px] left-full z-10 hidden max-h-[70vh] overflow-y-auto group-hover/sub:block">
                  <MenuList items={it.items} close={close} />
                </div>
              )}
            </div>
          );
        return (
          <button
            key={i}
            type="button"
            disabled={it.disabled}
            onClick={() => {
              close();
              it.run();
            }}
            className={`${row} enabled:hover:bg-[#2d8ceb] enabled:hover:text-white`}
          >
            <span className="w-3 text-[10px]">{it.checked ? "✓" : ""}</span>
            <span className="flex-1 whitespace-nowrap">{it.label}</span>
            {it.shortcut && <span className="pl-4 text-[11px] text-[#8a8a8a]">{it.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * AE's menu bar in the Pro header: Layer, Effect, Animation and Window, with their shortcuts.
 * Every item is an ordinary op (see actions.ts), so the agent can do the same through MCP.
 */
export function MenuBar() {
  const [open, setOpen] = useState<MenuName | null>(null);
  const [at, setAt] = useState({ x: 0, y: 0 });
  const bar = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const notice = useNotice((s) => s.notice);
  useMenuShortcuts();

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const n = e.target as Node;
      if (!bar.current?.contains(n) && !pop.current?.contains(n)) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const show = (m: MenuName, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ x: r.left, y: r.bottom + 2 });
    setOpen(m);
  };

  return (
    <>
      <div ref={bar} className="flex shrink-0 items-center" role="menubar">
        {Object.values(MenuName).map((m) => (
          <button
            key={m}
            type="button"
            role="menuitem"
            onClick={(e) => (open === m ? setOpen(null) : show(m, e.currentTarget))}
            onMouseEnter={(e) => open && open !== m && show(m, e.currentTarget)}
            className={`rounded-sm px-2 py-0.5 text-[12px] ${open === m ? "bg-[#3e3e3e] text-white" : "text-[#b5b5b5] hover:text-white"}`}
          >
            {m}
          </button>
        ))}
      </div>
      {notice && (
        <button type="button" onClick={clearNotice} className={`max-w-[28rem] truncate rounded-sm px-2 py-0.5 text-[11px] ${notice.kind === NoticeKind.Error ? "bg-[#e5484d]/15 text-[#ff8a8e]" : "bg-[#2d8ceb]/15 text-[#8cc4ff]"}`} title={notice.text}>
          {notice.text}
        </button>
      )}
      {open &&
        createPortal(
          <div ref={pop} className="fixed z-[200]" style={{ left: at.x, top: at.y }}>
            <MenuList items={buildMenus()[open]} close={() => setOpen(null)} />
          </div>,
          document.body,
        )}
      <LayerDialogs />
    </>
  );
}

function Dialog({ title, children, onOk, okLabel = "OK" }: { title: string; children: ReactNode; onOk: () => void; okLabel?: string }) {
  return createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-black/40" onPointerDown={(e) => e.target === e.currentTarget && openDialog(null)}>
      <form
        role="dialog"
        aria-label={title}
        onSubmit={(e) => {
          e.preventDefault();
          onOk();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") openDialog(null);
        }}
        className="flex w-80 flex-col gap-3 rounded-[3px] border border-[#111] bg-[#2b2b2b] p-4 text-[12px] text-[#d6d6d6] shadow-2xl"
      >
        <h2 className="text-[13px] font-medium text-white">{title}</h2>
        {children}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={() => openDialog(null)} className="rounded-sm px-3 py-1 text-[#b5b5b5] hover:text-white">
            Cancel
          </button>
          <button type="submit" className="rounded-sm bg-[#2d8ceb] px-3 py-1 text-white hover:bg-[#4aa3f0]">
            {okLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

const inputClass = "w-full rounded-sm bg-[#1b1b1b] px-2 py-1 text-[#e6e6e6] focus:ring-1 focus:ring-[#2d8ceb] focus:outline-none";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-[#a5a5a5]">{label}</span>
      {children}
    </label>
  );
}

/** Solid…, Camera… and Pre-compose…: what AE asks before it makes the layer. */
function LayerDialogs() {
  const dialog = useWorkspace((s) => s.dialog);
  const [W, H] = useEditor((s) => s.sceneSize);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#3d6bff");
  const [size, setSize] = useState<[number, number]>([W, H]);
  const [lens, setLens] = useState(DEFAULT_LENS_MM);
  useEffect(() => {
    if (dialog === DialogKind.Solid) setName("Solid"), setSize([W, H]);
    if (dialog === DialogKind.Precompose) setName("Pre-comp");
  }, [dialog, W, H]);
  if (!dialog) return null;
  const done = () => openDialog(null);

  if (dialog === DialogKind.Solid)
    return (
      <Dialog title="Solid Settings" onOk={() => (addNewLayer(NewLayer.Solid, { name, color, w: size[0], h: size[1] }), done())}>
        <Row label="Name">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </Row>
        <Row label="Size">
          <input type="number" min={1} value={size[0]} onChange={(e) => setSize([+e.target.value, size[1]])} className={inputClass} aria-label="Width" />
          ×
          <input type="number" min={1} value={size[1]} onChange={(e) => setSize([size[0], +e.target.value])} className={inputClass} aria-label="Height" />
        </Row>
        <button type="button" onClick={() => setSize([W, H])} className="self-start text-[11px] text-[#4aa3f0] hover:underline">
          Make Comp Size
        </button>
        <Row label="Color">
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-6 w-12 cursor-pointer bg-transparent" />
          <span className="font-mono text-[11px]">{color}</span>
        </Row>
      </Dialog>
    );

  if (dialog === DialogKind.Camera)
    return (
      <Dialog title="Camera Settings" onOk={() => (addNewLayer(NewLayer.Camera, { focal: focalPx(lens, W) }), done())}>
        <Row label="Preset">
          <select autoFocus value={lens} onChange={(e) => setLens(+e.target.value)} className={inputClass}>
            {LENSES.map(([label, mm]) => (
              <option key={mm} value={mm}>
                {label}
              </option>
            ))}
          </select>
        </Row>
        <p className="text-[11px] text-[#8a8a8a]">
          Zoom {focalPx(lens, W)} px on a {W} px wide comp (35 mm film). Its x/y is where it looks, z dollies it.
        </p>
        {hasCamera() && <p className="text-[11px] text-[#e5b84d]">This comp already has a camera: the engine uses one camera for the whole film.</p>}
      </Dialog>
    );

  const ids = selectedIds();
  return (
    <Dialog title="Pre-compose" onOk={() => (precompose(ids, name), done())}>
      <Row label="New name">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
      </Row>
      <p className="text-[11px] text-[#8a8a8a]">
        Moves {ids.length === 1 ? `"${ids[0]}"` : `${ids.length} layers`} into a new component and leaves one instance in their place.
      </p>
    </Dialog>
  );
}
