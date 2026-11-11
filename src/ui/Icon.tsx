// One stroke icon set for the whole UI (16 px, currentColor), instead of mixed Unicode glyphs.

const PATHS = {
  folder: "M2 4.5h4l1.5 1.5H14v6.5H2z",
  branch: "M5 2.5v8M5 10.5a1.75 1.75 0 1 0 0 3.5a1.75 1.75 0 0 0 0-3.5zM11 2.5a1.75 1.75 0 1 0 0 3.5a1.75 1.75 0 0 0 0-3.5zM11 6v1.5c0 1.5-1 2.5-3 2.5H5",
  gear: "M12.86 8.6L14.31 9.56L13.57 11.36L11.86 11.01L11.01 11.86L11.36 13.57L9.56 14.31L8.6 12.86L7.4 12.86L6.44 14.31L4.64 13.57L4.99 11.86L4.14 11.01L2.43 11.36L1.69 9.56L3.14 8.6L3.14 7.4L1.69 6.44L2.43 4.64L4.14 4.99L4.99 4.14L4.64 2.43L6.44 1.69L7.4 3.14L8.6 3.14L9.56 1.69L11.36 2.43L11.01 4.14L11.86 4.99L13.57 4.64L14.31 6.44L12.86 7.4zM8 6a2 2 0 1 0 0 4a2 2 0 0 0 0-4z",
  refresh: "M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3",
  pull: "M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10",
  push: "M8 13.5v-8M4.5 8.5L8 5l3.5 3.5M3 2.5h10",
  close: "M4 4l8 8M12 4l-8 8",
  discard: "M4 6.5h6a3 3 0 0 1 0 6H6.5M6.5 4L4 6.5 6.5 9",
  apply: "M3 8.5l3.5 3.5L13 4.5",
  terminal: "M3 4.5l3.5 3.5L3 11.5M8 11.5h5",
  list: "M6 4.5h7M6 8h7M6 11.5h7M3 4.5h.5M3 8h.5M3 11.5h.5",
  plus: "M8 3v10M3 8h10",
  right: "M6 4l4 4-4 4",
  down: "M4 6l4 4 4-4",
  up: "M4 10l4-4 4 4",
  sent: "M8 13V3.5M4.5 7L8 3.5 11.5 7",
  received: "M8 3v9.5M4.5 9L8 12.5 11.5 9",
  mail: "M2.5 4h11v8h-11zM2.5 4.5L8 8.5l5.5-4",
  link: "M7 9l2-2M6.5 5.5l1-1a2.1 2.1 0 0 1 3 3l-1 1M9.5 10.5l-1 1a2.1 2.1 0 0 1-3-3l1-1",
  file: "M4 2.5h5l3 3v8H4zM9 2.5v3h3",
  edit: "M10.5 2.5l3 3-8 8h-3v-3zM9 4l3 3",
  external: "M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4",
  history: "M8 2.5a5.5 5.5 0 1 0 0 11a5.5 5.5 0 0 0 0-11zM8 5v3l2 1.5",
  copy: "M5.5 5.5h7v8h-7zM3.5 10.5v-8h7",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9M7 7v4M9 7v4",
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
