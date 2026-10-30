// @vitest-environment node
import { expect, it } from "vitest";
import { neighbour } from "./nav";

it("wraps forward and backward", () => {
  expect(neighbour(2, 3, 1)).toBe(0);
  expect(neighbour(0, 3, -1)).toBe(2);
  expect(neighbour(1, 3, 1)).toBe(2);
});
