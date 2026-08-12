import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const catalog = JSON.parse(await readFile(new URL("../app/generated/catalog.json", import.meta.url), "utf8"));

test("catalog includes reviewed projects and unique identities", () => {
  assert.equal(catalog.version, 1);
  assert.ok(catalog.hosts.length > 0);
  assert.ok(catalog.projects.length > 0);
  assert.ok(catalog.projects.reduce((sum, project) => sum + project.services.length, 0) > 0);

  const projectIds = catalog.projects.map((project) => project.id);
  assert.equal(new Set(projectIds).size, projectIds.length);
  for (const project of catalog.projects) {
    const serviceIds = project.services.map((service) => service.id);
    assert.equal(new Set(serviceIds).size, serviceIds.length, `duplicate service ID in ${project.id}`);
    for (const service of project.services) {
      assert.ok(["always-on", "on-demand", "managed", "internal"].includes(service.mode), `missing mode for ${project.id}/${service.id}`);
    }
  }

  const tailscaleAddresses = catalog.hosts.flatMap((host) => host.tailscaleIPv4 ? [host.tailscaleIPv4] : []);
  assert.equal(new Set(tailscaleAddresses).size, tailscaleAddresses.length);
});

test("catalog does not contain obvious secret-bearing fields", () => {
  const serialized = JSON.stringify(catalog);
  assert.doesNotMatch(serialized, /password|api[_-]?key|private[_-]?key|bearer\s|secret[_-]?key/i);
});
