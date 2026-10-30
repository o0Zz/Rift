import { expect, it } from "vitest";
import { cwdFromOsc7, cwdFromOsc9 } from "./osc";

it("reads PowerShell's OSC 9;9", () => {
  expect(cwdFromOsc9('9;"C:\\Dev\\rift"')).toBe("C:\\Dev\\rift");
  expect(cwdFromOsc9("4;1;50")).toBeUndefined(); // progress report, not a cwd
});

it("reads bash/zsh OSC 7", () => {
  expect(cwdFromOsc7("file://my-mac/Users/me/My%20Project")).toBe("/Users/me/My Project");
  expect(cwdFromOsc7("file:///home/me")).toBe("/home/me");
  expect(cwdFromOsc7("file://host/")).toBe("/");
  expect(cwdFromOsc7("http://example.com")).toBeUndefined();
  // A raw % that is not an escape: kept as is.
  expect(cwdFromOsc7("file://h/tmp/100%")).toBe("/tmp/100%");
});
