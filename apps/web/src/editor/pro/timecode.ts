/** AE timecode `H:MM:SS:FF` at the scene's frame rate. */
export function timecode(t: number, fps: number) {
  const total = Math.round(Math.max(0, t) * fps);
  const f = total % Math.round(fps);
  const s = Math.floor(total / Math.round(fps));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
}
