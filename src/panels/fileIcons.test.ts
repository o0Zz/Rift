import { expect, it } from "vitest";
import { fileBadge } from "./fileIcons";

it("maps extensions to badges", () => {
  expect(fileBadge("App.tsx")?.label).toBe("TSX");
  expect(fileBadge("bench.ts")?.label).toBe("TS");
  expect(fileBadge("main.c")?.label).toBe("C");
  expect(fileBadge("tsconfig.json")?.label).toBe("{}");
  expect(fileBadge("lib.RS")?.label).toBe("RS");
});

it("knows some special file names", () => {
  expect(fileBadge("package.json")?.label).toBe("NPM");
  expect(fileBadge(".gitignore")?.label).toBe("GIT");
  expect(fileBadge("Dockerfile")?.label).toBe("DK");
});

it("returns nothing for unknown or extensionless files", () => {
  expect(fileBadge("LICENSE")).toBeUndefined();
  expect(fileBadge("archive.xyz")).toBeUndefined();
});
