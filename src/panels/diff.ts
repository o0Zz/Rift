/** Class of a unified-diff line, for coloring. */
export function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}
