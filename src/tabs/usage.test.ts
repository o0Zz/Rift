import { expect, it } from "vitest";
import { limitsLabel, limitsTitle } from "./usage";

it("labels the plan limits that are known", () => {
  expect(limitsLabel({ fiveHour: { used: 23.5, resetsAt: 0 }, sevenDay: { used: 41.2, resetsAt: 0 } })).toBe("5h 24% · 7d 41%");
  expect(limitsLabel({ sevenDay: { used: 7, resetsAt: 0 } })).toBe("7d 7%");
  expect(limitsLabel({})).toBe("");
});

it("says when each window resets", () => {
  const title = limitsTitle({ fiveHour: { used: 23.5, resetsAt: 1738425600 }, sevenDay: { used: 41, resetsAt: 1738857600 } }, "en-GB");
  expect(title).toMatch(/^5-hour limit: 24%, resets \d\d:\d\d\nWeekly limit: 41%, resets \w+ \d\d:\d\d$/);
});
