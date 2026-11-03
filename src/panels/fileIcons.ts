// File-type badges for the explorer: a short label + color per extension. Unknown types get a plain file icon.

type FileBadge = { label: string; color: string };

const BY_EXT: Record<string, FileBadge> = {};
const add = (exts: string, label: string, color: string) => {
  for (const ext of exts.split(" ")) BY_EXT[ext] = { label, color };
};

add("ts mts cts", "TS", "#3178c6");
add("tsx", "TSX", "#3178c6");
add("js mjs cjs", "JS", "#e8d44d");
add("jsx", "JSX", "#e8d44d");
add("json jsonc", "{}", "#e8d44d");
add("c h", "C", "#659ad2");
add("cpp cc cxx hpp hh", "C++", "#659ad2");
add("cs csproj", "C#", "#9b4f96");
add("rs", "RS", "#dea584");
add("py", "PY", "#4b8bbe");
add("go", "GO", "#00add8");
add("java", "JV", "#e76f00");
add("kt kts", "KT", "#a97bff");
add("php", "PHP", "#8892bf");
add("rb", "RB", "#cc342d");
add("swift", "SW", "#f05138");
add("html htm", "<>", "#e44d26");
add("xml xaml svg", "<>", "#e8a33d");
add("css", "#", "#563d7c");
add("scss sass less", "#", "#cd6799");
add("md mdx", "MD", "#519aba");
add("txt log", "TXT", "#8a8a8a");
add("yml yaml", "YML", "#cb171e");
add("toml ini cfg conf env", "CFG", "#9c9c9c");
add("sql", "SQL", "#dad8d8");
add("sh bash zsh", "SH", "#89e051");
add("ps1 psm1 psd1", "PS", "#5391fe");
add("bat cmd", "BAT", "#c1f12e");
add("png jpg jpeg gif bmp ico webp", "IMG", "#a074c4");
add("lock", "LCK", "#8a8a8a");
add("sln", "SLN", "#9b4f96");
add("dockerfile", "DK", "#2496ed");
add("vue", "VUE", "#41b883");
add("svelte", "SV", "#ff3e00");

const BY_NAME: Record<string, FileBadge> = {
  ".gitignore": { label: "GIT", color: "#f14e32" },
  ".gitattributes": { label: "GIT", color: "#f14e32" },
  dockerfile: BY_EXT.dockerfile,
  "cargo.toml": { label: "RS", color: "#dea584" },
  "package.json": { label: "NPM", color: "#cb3837" },
};

/** Badge for a file name, or `undefined` for a plain file icon. */
export function fileBadge(name: string): FileBadge | undefined {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  const dot = lower.lastIndexOf(".");
  return dot >= 0 ? BY_EXT[lower.slice(dot + 1)] : undefined;
}
