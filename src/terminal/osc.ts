// Folder reports sent by Rift's shell integration at every prompt.

/** OSC 9;9 (PowerShell on Windows): `9;"C:\path"`. */
export function cwdFromOsc9(data: string): string | undefined {
  if (!data.startsWith("9;")) return;
  return data.slice(2).replace(/^"(.*)"$/, "$1");
}

/** OSC 7 (bash/zsh): `file://host/path`, percent-encoded. */
export function cwdFromOsc7(data: string): string | undefined {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (!m) return;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
