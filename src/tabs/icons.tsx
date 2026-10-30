import { Match, Switch } from "solid-js";

/** Claude's orange starburst. */
function ClaudeIcon() {
  const rays = [0, 30, 60, 90, 120, 150];
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-label="Claude">
      <g stroke="#d97757" stroke-width="2.4" stroke-linecap="round">
        {rays.map((deg) => (
          <line x1="12" y1="2.5" x2="12" y2="21.5" transform={`rotate(${deg} 12 12)`} />
        ))}
      </g>
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-label="Agent">
      <circle cx="12" cy="12" r="8" fill="none" stroke="#b083f0" stroke-width="2.4" />
      <circle cx="12" cy="12" r="3" fill="#b083f0" />
    </svg>
  );
}

function ShellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-label="Shell">
      <path d="M5 7l5 5-5 5M12 18h7" fill="none" stroke="#888" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Icon for a tab: its agent's icon (by harness id) or a shell prompt. Add new agents here. */
export function TabIcon(props: { agent?: string }) {
  return (
    <Switch fallback={<AgentIcon />}>
      <Match when={!props.agent}>
        <ShellIcon />
      </Match>
      <Match when={props.agent === "claude"}>
        <ClaudeIcon />
      </Match>
    </Switch>
  );
}
