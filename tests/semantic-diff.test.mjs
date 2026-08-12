import assert from "node:assert/strict";
import test from "node:test";
import { semanticDiff, semanticEqual } from "../scripts/semantic-diff.mjs";

test("semantic comparison ignores object key formatting and order", () => {
  const left = { id: "example", service: { mode: "on-demand", host: "laptop" } };
  const right = { service: { host: "laptop", mode: "on-demand" }, id: "example" };
  assert.equal(semanticEqual(left, right), true);
  assert.deepEqual(semanticDiff(left, right), []);
});

test("semantic diff reports field-level project-to-catalog changes", () => {
  const catalog = {
    id: "example",
    services: [{ id: "web", url: "http://localhost:3000", mode: "on-demand" }],
    tags: ["old"],
  };
  const project = {
    id: "example",
    services: [{ id: "web", url: "http://localhost:4000", mode: "on-demand" }],
    tags: ["old", "new"],
  };

  assert.deepEqual(semanticDiff(catalog, project), [
    {
      path: "services[0].url",
      state: "changed",
      catalog: "http://localhost:3000",
      project: "http://localhost:4000",
    },
    { path: "tags[1]", state: "added", project: "new" },
  ]);
});
