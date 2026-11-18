import { expect, it } from "vitest";
import { cloneBase, clonePlan, repoName } from "./clone";

it("names the clone as git does", () => {
  expect(repoName("https://github.com/o0Zz/Rift.git")).toBe("Rift");
  expect(repoName("https://github.com/o0Zz/Rift/")).toBe("Rift");
  expect(repoName("git@github.com:o0Zz/Rift.git")).toBe("Rift");
  expect(repoName("git@host:repo")).toBe("repo");
  expect(repoName("https://host/")).toBe("host");
  expect(repoName("")).toBeUndefined();
});

it("clones next to the tab's repo, else in its folder", () => {
  expect(cloneBase({ root: "C:\\dev\\Rift", cwd: "C:\\dev\\Rift\\src" })).toBe("C:\\dev");
  expect(cloneBase({ cwd: "C:\\Users\\me" })).toBe("C:\\Users\\me");
  expect(cloneBase({ root: "C:\\" })).toBe("C:\\");
});

it("takes an optional folder after the URL, as git clone does", () => {
  const url = "https://github.com/o0Zz/Rift.git";
  expect(clonePlan(url, "C:\\dev")).toEqual({ url, parent: "C:\\dev", name: "Rift" });
  expect(clonePlan(`  ${url}  rift2 `, "C:\\dev")).toEqual({ url, parent: "C:\\dev", name: "rift2" });
  expect(clonePlan(`${url} D:\\work\\rift`, "C:\\dev")).toEqual({ url, parent: "D:\\work", name: "rift" });
  expect(clonePlan(`${url} "D:\\my work\\rift"`, "C:\\dev")).toEqual({ url, parent: "D:\\my work", name: "rift" });
  expect(clonePlan(`${url} sub/rift`, "/home/me")).toEqual({ url, parent: "/home/me/sub", name: "rift" });
  expect(clonePlan(`${url} /tmp/rift/`, "/home/me")).toEqual({ url, parent: "/tmp", name: "rift" });
  expect(clonePlan("", "C:\\dev")).toBeUndefined();
});
