export function Logo({ size = "text-[17px]" }: { size?: string }) {
  return (
    <span className={`${size} font-extrabold tracking-tight`}>
      motion<span className="text-[#e5484d]">i</span>ly
    </span>
  );
}
