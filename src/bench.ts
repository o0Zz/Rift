// Tab-switch benchmark, run by `npm run bench` (RIFT_BENCH=1). Prints a report and exits non-zero over budget.
import { invoke } from "@tauri-apps/api/core";
import type { TermView } from "./terminal/TermView";

type BenchApi = {
  newTab(): void;
  setPanels(open: boolean): void;
  views(): TermView[];
  activate(index: number): void;
  /** Opens a file of the bench repo (relative path) in tab `index`; it shows instead of the terminal. */
  openDoc(index: number, file: string): void;
  showsDoc(index: number): boolean;
  /** Gives the first `count` tabs their own shell in a terminal panel (each then displays two terminals). */
  openConsoles(count: number): Promise<void>;
  /** Tab `index`'s terminal panel, if it has one. */
  consoleOf(index: number): TermView | undefined;
};

// Tabs showing a document instead of their terminal: the Markdown reader and the code editor.
const DOCS: [number, string][] = [
  [3, "README.md"],
  [7, "src/App.tsx"],
  [11, "CLAUDE.md"],
  [15, "src-tauri/src/pty.rs"],
];

const TABS = 20;
const LINES = 10_000; // = scrollback, so every buffer is full
const SWITCHES = 100;
const BUDGET = { workP95: 16, latencyP95: 50 }; // ms
// Heavy output: the window must stay responsive (a frame at least every OUTPUT_FRAME_P95 ms, p95).
const OUTPUT_FRAME_P95 = 100;

type Sample = { work: number; latency: number; doc?: boolean };

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fill(view: TermView): Promise<void> {
  let text = "";
  for (let i = 0; i < LINES; i++) text += `\x1b[3${i % 8}mline ${i} ${"lorem ipsum ".repeat(6)}\x1b[0m\r\n`;
  return new Promise((r) => view.term.write(text, r));
}

/** Switches tabs and resolves once xterm has rendered the new one (or after 4 frames if nothing needed rendering). */
async function measure(api: BenchApi, i: number, doSwitch: () => void): Promise<Sample> {
  if (api.showsDoc(i)) {
    // A document is plain DOM: its cost is the style and layout of the next frame (forced and timed here,
    // like the terminals' render time), and it is on screen once that frame is painted.
    const t0 = performance.now();
    doSwitch();
    const sync = performance.now() - t0;
    await frame();
    const l0 = performance.now();
    void document.body.offsetHeight;
    const layout = performance.now() - l0;
    await sleep(0);
    return { work: sync + layout, latency: performance.now() - t0, doc: true };
  }
  // The tab's terminal, and its terminal panel's when it has one: the switch is done once both are rendered.
  const views = [api.views()[i], api.consoleOf(i)].filter((v) => v !== undefined);
  const rendered = new Map<TermView, Sample>();
  const t0 = performance.now();
  const subs = views.map((view) =>
    view.term.onRender(() => {
      // document.timeline.currentTime is the current frame's start, so this is the render frame's main-thread time.
      const now = performance.now();
      if (!rendered.has(view)) rendered.set(view, { work: now - Number(document.timeline.currentTime), latency: now - t0 });
    }),
  );
  doSwitch();
  const sync = performance.now() - t0;
  for (let i = 0; i < 4 && rendered.size < views.length; i++) await frame();
  subs.forEach((s) => s.dispose());
  const all = [...rendered.values()];
  return all.length
    ? { work: sync + Math.max(...all.map((r) => r.work)), latency: Math.max(...all.map((r) => r.latency)) }
    : { work: sync, latency: performance.now() - t0 };
}

async function scenario(api: BenchApi, order: number[], gap = 30): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const i of order) {
    samples.push(await measure(api, i, () => api.activate(i)));
    await sleep(gap);
  }
  return samples;
}

function pct(values: number[], p: number) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function summarize(name: string, samples: Sample[]) {
  const work = samples.map((s) => s.work);
  const latency = samples.map((s) => s.latency);
  const ok = pct(work, 95) < BUDGET.workP95 && pct(latency, 95) < BUDGET.latencyP95;
  const f = (v: number[]) => `p50 ${pct(v, 50).toFixed(1)}  p95 ${pct(v, 95).toFixed(1)}  max ${Math.max(...v).toFixed(1)}`;
  const docs = samples.filter((s) => s.doc);
  const split = docs.length
    ? `\n  to a document tab (${docs.length}): work ${f(docs.map((s) => s.work))}, latency ${f(docs.map((s) => s.latency))} ms`
    : "";
  return { ok, text: `${ok ? "PASS" : "FAIL"} ${name}\n  work    ${f(work)} ms\n  latency ${f(latency)} ms${split}` };
}

/**
 * Prints `file` in the active tab (PowerShell) and measures throughput and the gaps between frames while
 * the output streams: a long gap is a frozen window.
 */
async function heavyOutput(view: TermView, file: string, bytes: number): Promise<{ ok: boolean; text: string }> {
  const gaps: number[] = [];
  let streaming = true;
  let last = performance.now();
  const tick = (now: number) => {
    gaps.push(now - last);
    last = now;
    if (streaming) requestAnimationFrame(tick);
  };
  const done = new Promise<void>((resolve) => {
    const sub = view.term.onWriteParsed(() => {
      const buf = view.term.buffer.active;
      for (let y = buf.baseY + buf.cursorY; y >= Math.max(0, buf.baseY + buf.cursorY - 3); y--) {
        if (buf.getLine(y)?.translateToString().includes("RIFT-BENCH-END")) {
          sub.dispose();
          resolve();
          return;
        }
      }
    });
  });
  const t0 = performance.now();
  requestAnimationFrame(tick);
  const path = file.replace(/'/g, "''");
  await invoke("pty_write", {
    id: view.ptyId,
    data: `[Console]::Out.Write([IO.File]::ReadAllText('${path}')); 'RIFT-BENCH-' + 'END'\r`,
  });
  const finished = await Promise.race([done.then(() => true), sleep(90_000).then(() => false)]);
  streaming = false;
  if (!finished) {
    const buf = view.term.buffer.active;
    const end = buf.baseY + buf.cursorY;
    const tail = Array.from({ length: 6 }, (_, i) => buf.getLine(end - 5 + i)?.translateToString().trimEnd() ?? "");
    return { ok: false, text: `FAIL heavy output: no end marker after 90 s; last lines:\n  ${tail.join("\n  ")}` };
  }
  const seconds = (performance.now() - t0) / 1000;
  const p95 = pct(gaps, 95);
  const ok = p95 < OUTPUT_FRAME_P95;
  const mb = bytes / 1e6;
  return {
    ok,
    text:
      `${ok ? "PASS" : "FAIL"} heavy output (${mb.toFixed(1)} MB)\n` +
      `  ${seconds.toFixed(1)} s, ${(mb / seconds).toFixed(1)} MB/s; frame gaps p50 ${pct(gaps, 50).toFixed(0)}  p95 ${p95.toFixed(0)}  max ${Math.max(...gaps).toFixed(0)} ms (budget p95 < ${OUTPUT_FRAME_P95})`,
  };
}

export async function run(api: BenchApi) {
  while (api.views().length < TABS) api.newTab();
  for (const v of api.views()) await fill(v);
  await sleep(1000); // let the shells print their prompts

  const cycle = Array.from({ length: SWITCHES }, (_, k) => k % TABS);
  const toggle = Array.from({ length: SWITCHES }, (_, k) => k % 2);
  for (const [i, file] of DOCS) api.openDoc(i, file);
  await scenario(api, cycle.slice(0, TABS)); // warm-up lap (documents are read when first shown)
  await sleep(1000);
  const results = [
    summarize(`cycle ${TABS} tabs (Ctrl+PgDn)`, await scenario(api, cycle)),
    summarize("toggle 2 tabs", await scenario(api, toggle)),
  ];
  // Panels open; the 250 ms gap lets each panel load (150 ms debounce) between switches, so their work shows up.
  // Opening them narrows every terminal: wait for the idle-time resize of the hidden tabs first.
  api.setPanels(true);
  await sleep(5000);
  results.push(summarize("cycle with files + git panels open", await scenario(api, cycle.slice(0, 40), 250)));
  // Every tab but the last with its own shell in a terminal panel: each switch displays two terminals (worst
  // case), and the last tab shows the panel's "Start a terminal here" in between.
  api.setPanels(false);
  await api.openConsoles(TABS - 1);
  for (let i = 0; i < TABS - 1; i++) await fill(api.consoleOf(i)!);
  await sleep(5000);
  results.push(summarize("cycle, tabs with a terminal panel", await scenario(api, cycle)));
  // Showing and hiding that button once erased the panel's terminals (a lone <Show> clears its parent).
  const lost = [...api.views(), ...Array.from({ length: TABS - 1 }, (_, i) => api.consoleOf(i)!)].filter((v) => !v.el.isConnected);
  if (lost.length) results.push({ ok: false, text: `FAIL ${lost.length} terminal(s) no longer in the page after the cycle` });
  const output = await invoke<[string, number] | null>("bench_output_file");
  if (output) {
    // A fresh tab: the others hold lines written straight into xterm, which ConPTY's own screen model does
    // not know about, so its repaints would land in the wrong place.
    const before = new Set(api.views());
    api.newTab();
    const fresh = api.views().find((v) => !before.has(v))!;
    await sleep(3000); // shell started, prompt shown
    results.push(await heavyOutput(fresh, ...output));
  }
  const report = [
    `Rift tab-switch bench: ${TABS} tabs x ${LINES} lines (${DOCS.length} of them showing a document), ${SWITCHES} switches each`,
    `budget (switching): work p95 < ${BUDGET.workP95} ms, latency p95 < ${BUDGET.latencyP95} ms`,
    ...results.map((r) => r.text),
  ].join("\n");
  await invoke("bench_done", { report, ok: results.every((r) => r.ok) });
}
