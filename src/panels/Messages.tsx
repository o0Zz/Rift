import { createSignal, For, Show } from "solid-js";
import { PanelHead } from "../ui/Panel";
import { Icon } from "../ui/Icon";
import type { Entry } from "../messages/bus";

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** What agents sent each other and which agents they started, newest first. A name opens that agent's tab. */
export function Messages(p: {
  entries: Entry[];
  enabled: boolean | undefined;
  onOpen(pty: number): void;
  onClear(): void;
  onClose(): void;
}) {
  const [open, setOpen] = createSignal<number>();
  const Who = (w: { pty: number; name: string }) => (
    <button class="link msg-who" title={`Agent ${w.pty}: open its tab`} onClick={() => p.onOpen(w.pty)}>
      {w.name}
    </button>
  );
  return (
    // Zoomed with the prompts panel (same text scale).
    <aside class="panel messages" data-zoom="prompts">
      <PanelHead title="Agent messages" tip="Agent messaging (Rift's MCP tools)" closeTip="Close (Ctrl+Shift+M)" onClose={p.onClose}>
        <button class="icon-btn" title="Clear the delivered messages" onClick={() => p.onClear()}>
          <Icon name="discard" />
        </button>
      </PanelHead>
      <div class="msg-list">
        <Show
          when={p.entries.length}
          fallback={
            <div class="tree-note">
              {p.enabled === false
                ? "Agent messaging is off: turn it on in Settings → Agents."
                : "No messages yet. Agents talk through Rift's MCP tools: list_agents, send_message, start_agent."}
            </div>
          }
        >
          <For each={[...p.entries].reverse()}>
            {(e) => (
              <div class="msg" classList={{ [e.state]: true }}>
                <div class="msg-head">
                  <span class="msg-time">{time(e.time)}</span>
                  <Who pty={e.from} name={e.fromName} />
                  <span class="msg-arrow" title={e.kind === "start" ? "started" : "sent to"}>
                    <Icon name={e.kind === "start" ? "plus" : "right"} size={11} />
                  </span>
                  <Who pty={e.to} name={e.toName} />
                  <span class="msg-state" title={e.note}>
                    {e.state === "queued" ? "waiting" : e.state === "failed" ? `failed: ${e.note}` : e.kind === "start" ? "started" : "delivered"}
                  </span>
                </div>
                <div class="msg-text" classList={{ open: open() === e.id }} onClick={() => setOpen(open() === e.id ? undefined : e.id)}>
                  {e.text}
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
    </aside>
  );
}
