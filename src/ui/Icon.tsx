// One stroke icon set for the whole UI (16 px, currentColor), instead of mixed Unicode glyphs.

const PATHS = {
  folder: "M2 4.5h4l1.5 1.5H14v6.5H2z",
  branch: "M5 2.5v8M5 10.5a1.75 1.75 0 1 0 0 3.5a1.75 1.75 0 0 0 0-3.5zM11 2.5a1.75 1.75 0 1 0 0 3.5a1.75 1.75 0 0 0 0-3.5zM11 6v1.5c0 1.5-1 2.5-3 2.5H5",
  gear: "M8 5.75a2.25 2.25 0 1 0 0 4.5a2.25 2.25 0 0 0 0-4.5zM8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05",
  refresh: "M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3",
  close: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  right: "M6 4l4 4-4 4",
  down: "M4 6l4 4 4-4",
  up: "M4 10l4-4 4 4",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon(props: { name: IconName; size?: number }) {
  const size = () => props.size ?? 16;
  return (
    <svg
      class="icon"
      width={size()}
      height={size()}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[props.name]} />
    </svg>
  );
}
