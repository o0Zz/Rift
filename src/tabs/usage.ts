// Live numbers from the agent's status line (`agent-usage`): context per tab, plan limits for the top bar.

/** A plan window: percent used and when it resets (Unix epoch seconds). */
export type Limit = { used: number; resetsAt: number };
export type Limits = { fiveHour?: Limit; sevenDay?: Limit };

/** "5h 23% · 7d 41%", each part only when known; "" when neither is. */
export function limitsLabel(l: Limits): string {
  return [l.fiveHour && `5h ${Math.round(l.fiveHour.used)}%`, l.sevenDay && `7d ${Math.round(l.sevenDay.used)}%`]
    .filter(Boolean)
    .join(" · ");
}

/** Tooltip: when each window resets, in local time. */
export function limitsTitle(l: Limits, locale?: string): string {
  const at = (s: number, opts: Intl.DateTimeFormatOptions) => new Date(s * 1000).toLocaleString(locale, opts);
  return [
    l.fiveHour && `5-hour limit: ${Math.round(l.fiveHour.used)}%, resets ${at(l.fiveHour.resetsAt, { hour: "2-digit", minute: "2-digit" })}`,
    l.sevenDay && `Weekly limit: ${Math.round(l.sevenDay.used)}%, resets ${at(l.sevenDay.resetsAt, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Context at or above this percent shows as a warning: the agent will compact soon. */
export const CONTEXT_WARN = 80;
