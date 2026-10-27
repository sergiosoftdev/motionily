// Run: pnpm --filter @motionily/web test (node's own runner, types stripped).
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandFor, comboFromEvent, conflicts, keymap, KeyPreset, KeyScope } from "../src/keys/keymap.ts";

const press = (key: string, code: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean } = {}) =>
  ({ key, code, metaKey: !!mods.meta, ctrlKey: false, shiftKey: !!mods.shift, altKey: !!mods.alt }) as KeyboardEvent;

test("Motionily's map: playback everywhere, Pro's and Edit's own keys", () => {
  keymap.setPreset(KeyPreset.Motionily);
  assert.equal(commandFor(press(" ", "Space"), KeyScope.Transport)?.id, "transport.play_pause");
  assert.equal(commandFor(press("j", "KeyJ"), KeyScope.Transport)?.id, "transport.shuttle_back");
  assert.equal(commandFor(press("j", "KeyJ"), KeyScope.Pro)?.id, "pro.prev_item", "Pro's J (After Effects) wins in Pro");
  assert.equal(commandFor(press("P", "KeyP", { shift: true }), KeyScope.Pro)?.id, "pro.reveal_position", "Shift adds to a reveal");
  assert.equal(commandFor(press("b", "KeyB", { meta: true }), KeyScope.Edit)?.id, "edit.blade");
  assert.equal(commandFor(press("z", "KeyZ", { meta: true, shift: true }), KeyScope.Edit)?.id, "edit.redo");
  assert.equal(commandFor(press("ArrowRight", "ArrowRight"), KeyScope.Transport), undefined, "plain arrows are free by default");
});

test("presets follow the editor people come from", () => {
  keymap.setPreset(KeyPreset.Premiere);
  assert.equal(commandFor(press("ArrowRight", "ArrowRight"), KeyScope.Transport)?.id, "transport.next_frame");
  assert.equal(commandFor(press("k", "KeyK", { meta: true }), KeyScope.Edit)?.id, "edit.blade", "Premiere's Add Edit");
  assert.equal(commandFor(press(",", "Comma"), KeyScope.Edit)?.id, "edit.insert");
  assert.equal(commandFor(press("v", "KeyV"), KeyScope.Edit)?.id, "edit.select_tool");
  assert.equal(commandFor(press("F11", "F11"), KeyScope.Edit), undefined, "Premiere has no replace key");
  keymap.setPreset(KeyPreset.FinalCut);
  assert.equal(commandFor(press("w", "KeyW"), KeyScope.Edit)?.id, "edit.insert");
  assert.equal(commandFor(press("d", "KeyD"), KeyScope.Edit)?.id, "edit.overwrite");
  assert.equal(commandFor(press("R", "KeyR", { shift: true }), KeyScope.Edit)?.id, "edit.replace");
  keymap.setPreset(KeyPreset.Resolve);
  assert.equal(commandFor(press("b", "KeyB", { meta: true }), KeyScope.Edit)?.id, "edit.blade");
});

test("no preset ships two commands on one key in the same place", () => {
  for (const p of Object.values(KeyPreset)) {
    keymap.setPreset(p);
    assert.deepEqual([...conflicts().keys()], [], `${p} has conflicts`);
  }
});

test("a key the user assigns replaces the preset's, shows a clash, and resets", () => {
  keymap.setPreset(KeyPreset.Motionily);
  const x = comboFromEvent(press("x", "KeyX"))!;
  assert.deepEqual(x, { code: "KeyX", cmd: false, shift: false, alt: false }, "the physical key, so other layouts keep it");
  keymap.setCustom("edit.blade", [x]);
  assert.equal(commandFor(press("x", "KeyX"), KeyScope.Edit)?.id, "edit.blade");
  assert.equal(commandFor(press("s", "KeyS"), KeyScope.Edit), undefined, "the old key is free");
  keymap.setCustom("edit.blade", [comboFromEvent(press("a", "KeyA"))!]);
  assert.deepEqual(conflicts().get("edit.blade"), ["edit.select_tool"]);
  keymap.setCustom("edit.blade", null);
  assert.equal(commandFor(press("s", "KeyS"), KeyScope.Edit)?.id, "edit.blade");
  assert.equal(comboFromEvent(press("Shift", "ShiftLeft", { shift: true })), null, "a modifier alone is not a key");
});
