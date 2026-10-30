// Tab-switch benchmark, run by `npm run bench` (RIFT_BENCH=1). Prints a report and exits non-zero over budget.
import { invoke } from "@tauri-apps/api/core";
import type { TermView } from "./terminal/TermView";

export type BenchApi = {
  newTab(): void;
  views(): TermView[];
  activate(index: number): void;
};

const TABS = 20;
const LINES = 10_000; // = scrollback, so every buffer is full
const SWITCHES = 100;
const BUDGET = { workP95: 16, latencyP95: 50 }; // ms

type Sample = { work: number; latency: number };

const frame = () => new Promise<number>((r) => requestAnimationFrame(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fill(view: TermView): Promise<void> {
  let text = "";
  for (let i = 0; i < LINES; i++) text += `\x1b[3${i % 8}mline ${i} ${"lorem ipsum ".repeat(6)}\x1b[0m\r\n`;
  return new Promise((r) => view.term.write(text, r));
}

/** Switches tabs and resolves once xterm has rendered the new one (or after 4 frames if nothing needed rendering). */
async function measure(view: TermView, doSwitch: () => void): Promise<Sample> {
  let rendered: Sample | undefined;
  const t0 = performance.now();
  const sub = view.term.onRender(() => {
    // document.timeline.currentTime is the current frame's start, so this is the render frame's main-thread time.
    const now = performance.now();
    rendered ??= { work: now - Number(document.timeline.currentTime), latency: now - t0 };
  });
  doSwitch();
  const sync = performance.now() - t0;
  for (let i = 0; i < 4 && !rendered; i++) await frame();
  sub.dispose();
  return rendered
    ? { work: sync + rendered.work, latency: rendered.latency }
    : { work: sync, latency: performance.now() - t0 };
}

async function scenario(api: BenchApi, order: number[]): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const i of order) {
    samples.push(await measure(api.views()[i], () => api.activate(i)));
    await sleep(30);
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
  return { ok, text: `${ok ? "PASS" : "FAIL"} ${name}\n  work    ${f(work)} ms\n  latency ${f(latency)} ms` };
}

export async function run(api: BenchApi) {
  while (api.views().length < TABS) api.newTab();
  for (const v of api.views()) await fill(v);
  await sleep(1000); // let the shells print their prompts

  const cycle = Array.from({ length: SWITCHES }, (_, k) => k % TABS);
  const toggle = Array.from({ length: SWITCHES }, (_, k) => k % 2);
  await scenario(api, cycle.slice(0, TABS)); // warm-up lap
  const results = [
    summarize(`cycle ${TABS} tabs (Ctrl+PgDn)`, await scenario(api, cycle)),
    summarize("toggle 2 tabs", await scenario(api, toggle)),
  ];
  const report = [
    `Rift tab-switch bench: ${TABS} tabs x ${LINES} lines, ${SWITCHES} switches each`,
    `budget: work p95 < ${BUDGET.workP95} ms, latency p95 < ${BUDGET.latencyP95} ms`,
    ...results.map((r) => r.text),
  ].join("\n");
  await invoke("bench_done", { report, ok: results.every((r) => r.ok) });
}
