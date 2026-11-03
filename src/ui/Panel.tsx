import { Match, Switch, untrack, type Accessor, type JSX } from "solid-js";
import { Icon } from "./Icon";

/**
 * A side panel's header: title, its buttons, then × (when `onClose`). Keeps the `panel-head` class: the pane tree
 * starts a panel drag from it.
 */
export function PanelHead(p: { title: JSX.Element; tip?: string; closeTip?: string; onClose?(): void; children?: JSX.Element }) {
  return (
    <div class="panel-head">
      <span class="panel-title" title={p.tip}>
        {p.title}
      </span>
      <span class="head-buttons">
        {p.children}
        {p.onClose && (
          <button class="icon-btn" title={p.closeTip ?? "Close"} onClick={() => p.onClose!()}>
            <Icon name="close" />
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * A value a command loads: `fallback` until it arrives, its error when the command failed (a string), else
 * `children`. Follows the value: a reload in place that turns an error into a list (or back) shows the new state.
 */
export function Loaded<T>(p: {
  value: T | string | undefined;
  fallback?: JSX.Element;
  children: (value: Accessor<T>) => JSX.Element;
}) {
  return (
    // Built once per state change (Switch keeps it while the value stays loaded), never tracked: the children
    // follow the value through the accessor.
    <Switch fallback={untrack(() => p.children(() => p.value as T))}>
      <Match when={p.value === undefined}>{p.fallback ?? <div class="tree-note">Loading…</div>}</Match>
      <Match when={typeof p.value === "string"}>
        <div class="tree-note error">{p.value as string}</div>
      </Match>
    </Switch>
  );
}
