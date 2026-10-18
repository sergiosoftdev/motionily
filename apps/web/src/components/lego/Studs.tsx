/** The little cylinders on top of a Lego brick. Purely decorative. */
export function Studs({ count, color }: { count: number; color: string }) {
  return (
    <span aria-hidden className="pointer-events-none absolute -top-[5px] left-3 flex gap-2">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="block h-[7px] w-3.5 rounded-t-[4px]"
          style={{ background: color, boxShadow: "inset 0 1.5px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(0,0,0,.2)" }}
        />
      ))}
    </span>
  );
}
