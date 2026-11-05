import type * as Path from "effect/Path";

export const isWithinRoot = (path: Path.Path, candidate: string, root: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};
