import { Show } from "solid-js";
import type { GitStats } from "./Tab";

/** "+12 −3 ↑1 ↓2", each part only when non-zero. */
export function GitStatsView(props: { stats?: GitStats }) {
  return (
    <Show when={props.stats}>
      {(s) => (
        <>
          <Show when={s().added}>
            <span class="stat-add">+{s().added}</span>
          </Show>
          <Show when={s().deleted}>
            <span class="stat-del">−{s().deleted}</span>
          </Show>
          <Show when={s().ahead}>
            <span class="stat-ab">↑{s().ahead}</span>
          </Show>
          <Show when={s().behind}>
            <span class="stat-ab">↓{s().behind}</span>
          </Show>
        </>
      )}
    </Show>
  );
}
