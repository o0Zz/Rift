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

/** Codex: a green ring with a prompt chevron. */
function CodexIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-label="Codex">
      <circle cx="12" cy="12" r="9" fill="none" stroke="#10a37f" stroke-width="2.4" />
      <path d="M8.5 9l3 3-3 3M13 15.5h3" fill="none" stroke="#10a37f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Gemini: a blue four-point sparkle. */
function GeminiIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-label="Gemini">
      <path d="M12 2c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10z" fill="#4c8df6" />
    </svg>
  );
}

/** Copilot: goggles. */
function CopilotIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-label="Copilot">
      <g fill="none" stroke="#a371f7" stroke-width="2.2">
        <circle cx="7.5" cy="12" r="4.5" />
        <circle cx="16.5" cy="12" r="4.5" />
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
      <Match when={props.agent === "codex"}>
        <CodexIcon />
      </Match>
      <Match when={props.agent === "gemini"}>
        <GeminiIcon />
      </Match>
      <Match when={props.agent === "copilot"}>
        <CopilotIcon />
      </Match>
    </Switch>
  );
}
