// One stroke icon set for the whole UI (16 px, currentColor), instead of mixed Unicode glyphs.

const PATHS = {
  folder: "M2 4.5h4l1.5 1.5H14v6.5H2z",
  branch: "M5 2.5v8M5 10.5a1.75 1.75 0 1 0 0 3.5a1.75 1.75 0 0 0 0-3.5zM11 2.5a1.75 1.75 0 1 0 0 3.5a1.75 1.75 0 0 0 0-3.5zM11 6v1.5c0 1.5-1 2.5-3 2.5H5",
  gear: "M12.86 8.6L14.31 9.56L13.57 11.36L11.86 11.01L11.01 11.86L11.36 13.57L9.56 14.31L8.6 12.86L7.4 12.86L6.44 14.31L4.64 13.57L4.99 11.86L4.14 11.01L2.43 11.36L1.69 9.56L3.14 8.6L3.14 7.4L1.69 6.44L2.43 4.64L4.14 4.99L4.99 4.14L4.64 2.43L6.44 1.69L7.4 3.14L8.6 3.14L9.56 1.69L11.36 2.43L11.01 4.14L11.86 4.99L13.57 4.64L14.31 6.44L12.86 7.4zM8 6a2 2 0 1 0 0 4a2 2 0 0 0 0-4z",
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
