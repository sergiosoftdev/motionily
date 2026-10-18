/** Every slot of a project. A brick fills exactly one slot. */
export enum BrickSlot {
  MotionStyle = "motion_style",
  Palette = "palette",
  Composition = "composition",
  Typography = "typography",
  RenderStyle = "render_style",
  Captions = "captions",
  Scenario = "scenario",
  Character = "character",
  Animation = "animation",
  Transition = "transition",
}

export enum SlotCardinality {
  /** Always filled with exactly one brick. */
  One = "one",
  /** Empty or one brick. */
  Optional = "optional",
  /** Any number of bricks. */
  Many = "many",
}

export const SLOT_CARDINALITY: Record<BrickSlot, SlotCardinality> = {
  [BrickSlot.MotionStyle]: SlotCardinality.One,
  [BrickSlot.Palette]: SlotCardinality.One,
  [BrickSlot.Composition]: SlotCardinality.One,
  [BrickSlot.Typography]: SlotCardinality.One,
  [BrickSlot.RenderStyle]: SlotCardinality.One,
  [BrickSlot.Captions]: SlotCardinality.One,
  [BrickSlot.Scenario]: SlotCardinality.Optional,
  [BrickSlot.Character]: SlotCardinality.Many,
  [BrickSlot.Animation]: SlotCardinality.Many,
  [BrickSlot.Transition]: SlotCardinality.Many,
};

/** Whether the render engine can already draw this brick. */
export enum EngineSupport {
  Supported = "supported",
  Planned = "planned",
}

export enum BrickVisibility {
  /** Part of the Motionily library, visible to everyone. */
  Official = "official",
  /** Created by the agent for one project. */
  Private = "private",
}

export enum ParamType {
  Number = "number",
  Color = "color",
  Choice = "choice",
}
