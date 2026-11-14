import { describe, expect, it } from "vite-plus/test";

import { pastedImagePaths } from "./attachments.ts";

describe("pastedImagePaths", () => {
  it.each([
    ["/tmp/shot.png", ["/tmp/shot.png"]],
    ["/Users/me/My\\ Shots/a\\ b.JPG ", ["/Users/me/My Shots/a b.JPG"]],
    ["'/Users/me/My Shots/a.webp'", ["/Users/me/My Shots/a.webp"]],
    ["file:///Users/me/a%20b.gif", ["/Users/me/a b.gif"]],
    ["/tmp/a.png /tmp/b.jpeg", ["/tmp/a.png", "/tmp/b.jpeg"]],
  ] as const)("reads %j as dropped images", (pasted, paths) => {
    expect(pastedImagePaths(pasted)).toEqual(paths);
  });

  it.each(["look at /tmp/shot.png", "/tmp/notes.md", "relative/shot.png", ""])(
    "leaves %j as text",
    (pasted) => {
      expect(pastedImagePaths(pasted)).toBeNull();
    },
  );
});
