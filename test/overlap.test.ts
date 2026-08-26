import test from "node:test";
import assert from "node:assert/strict";
import { describeOverlaps, findOverlaps } from "../src/core/overlap.js";

test("lanes that touched different files do not overlap", () => {
  assert.deepEqual(
    findOverlaps([
      { id: "A", paths: ["src/api.ts", "test/api.ts"] },
      { id: "B", paths: ["src/page.tsx"] },
    ]),
    [],
  );
});

test("a file two lanes both touched is reported with both of them", () => {
  const found = findOverlaps([
    { id: "A", paths: ["src/api.ts", "src/types.ts"] },
    { id: "B", paths: ["src/page.tsx", "src/types.ts"] },
  ]);
  assert.deepEqual(found, [{ path: "src/types.ts", lanes: ["A", "B"] }]);
});

test("lane ids come back in the order the lanes were given", () => {
  const found = findOverlaps([
    { id: "C", paths: ["shared.ts"] },
    { id: "A", paths: ["shared.ts"] },
  ]);
  assert.deepEqual(found[0]!.lanes, ["C", "A"]);
});

test("one lane naming a path twice is still one lane", () => {
  // git will not normally do this, but a lane's paths are data from outside
  // this function, and "A conflicts with A" would be a nonsense warning.
  assert.deepEqual(findOverlaps([{ id: "A", paths: ["dup.ts", "dup.ts"] }]), []);
});

test("the most contested file is named first", () => {
  const found = findOverlaps([
    { id: "A", paths: ["two.ts", "three.ts"] },
    { id: "B", paths: ["two.ts", "three.ts"] },
    { id: "C", paths: ["three.ts"] },
  ]);
  assert.deepEqual(found.map((o) => o.path), ["three.ts", "two.ts"]);
  assert.deepEqual(found[0]!.lanes, ["A", "B", "C"]);
});

test("files contested equally are ordered by name, so the warning reads the same every time", () => {
  const one = findOverlaps([
    { id: "A", paths: ["b.ts", "a.ts", "c.ts"] },
    { id: "B", paths: ["c.ts", "a.ts", "b.ts"] },
  ]);
  const two = findOverlaps([
    { id: "A", paths: ["c.ts", "b.ts", "a.ts"] },
    { id: "B", paths: ["a.ts", "b.ts", "c.ts"] },
  ]);
  assert.deepEqual(one.map((o) => o.path), ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(one, two);
});

test("nothing overlapping means nothing is said", () => {
  assert.equal(describeOverlaps([]), null);
});

test("the warning names the file and who wants it", () => {
  const text = describeOverlaps([{ path: "src/types.ts", lanes: ["A", "B"] }]);
  assert.equal(text, "lanes overlap: src/types.ts (A, B) — landing both may conflict");
});

test("a long list of clashes is cut short rather than filling the room", () => {
  const many = ["a", "b", "c", "d", "e", "f"].map((p) => ({ path: `${p}.ts`, lanes: ["A", "B"] }));
  const text = describeOverlaps(many)!;
  assert.match(text, /a\.ts \(A, B\)/);
  assert.match(text, /and 2 more files/);
  assert.doesNotMatch(text, /f\.ts/);
});

test("exactly one file over the limit is counted in the singular", () => {
  const five = ["a", "b", "c", "d", "e"].map((p) => ({ path: `${p}.ts`, lanes: ["A", "B"] }));
  assert.match(describeOverlaps(five)!, /and 1 more file —/);
});
