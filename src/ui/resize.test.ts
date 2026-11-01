import { expect, it } from "vitest";
import { resized } from "./resize";

it("grows a box toward its handle's side, within its limits", () => {
  expect(resized("right", 200, 30, 100, 400)).toBe(230);
  expect(resized("left", 200, 30, 100, 400)).toBe(170); // a handle on the left edge: dragging right shrinks it
  expect(resized("bottom", 150, 40, 60, 500)).toBe(190); // dragging down makes it taller
  expect(resized("bottom", 150, -200, 60, 500)).toBe(60);
  expect(resized("top", 150, -40, 60, 500)).toBe(190); // a handle on the top edge: dragging up makes it taller
  expect(resized("right", 200, 900, 100, 400)).toBe(400);
});
