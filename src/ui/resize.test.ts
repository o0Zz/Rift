import { expect, it } from "vitest";
import { resized } from "./resize";

it("grows a box with its handle, within its limits", () => {
  expect(resized(200, 30, 100, 400)).toBe(230);
  expect(resized(150, -200, 60, 500)).toBe(60);
  expect(resized(200, 900, 100, 400)).toBe(400);
});
