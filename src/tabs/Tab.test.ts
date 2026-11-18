import { expect, it } from "vitest";
import { Tab } from "./Tab";

it("files panel shows the repo, the terminal's folder when git is pinned elsewhere, or the folder picked with ..", () => {
  const tab = new Tab();
  tab.main.cwd = "C:\\work\\api\\src";
  expect(tab.filesRoot).toBe("C:\\work\\api\\src");
  tab.root = "C:\\work\\api";
  expect(tab.filesRoot).toBe("C:\\work\\api");

  // Terminal one level above the repos, git pinned to one of them: files stay on the terminal's folder.
  tab.main.cwd = "C:\\work";
  tab.gitDir = "C:\\work\\api";
  expect(tab.filesRoot).toBe("C:\\work");

  tab.filesDir = "C:\\";
  expect(tab.filesRoot).toBe("C:\\");
});
