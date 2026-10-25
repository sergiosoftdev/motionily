import { OpName, effectsWithGradeOf, type Op } from "@motionily/protocol";
import { engineHost } from "../../engine/host";
import { useEditor } from "../../store";
import { COLOR_FX } from "./colorGrade";

/** Copy a clip's grade (its color effects, LUT included); false when it has none. */
export function copyGrade(clipId: string): boolean {
  const effects = (engineHost.layer(clipId)?.effects as Record<string, unknown>[] | undefined) ?? [];
  const grade = effects.filter((e) => e.fx === COLOR_FX);
  if (!grade.length) return false;
  useEditor.setState({ gradeClipboard: grade });
  return true;
}

/** Ops that paste the copied grade onto `ids` (their other effects stay); null with nothing copied. */
export function pasteGradeOps(ids: string[]): Op[] | null {
  const grade = useEditor.getState().gradeClipboard;
  if (!grade) return null;
  return ids.map((id) => ({ op: OpName.Patch, id, fields: { effects: effectsWithGradeOf(engineHost.layer(id)?.effects as unknown[] | undefined, grade) } }));
}
