import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HostMonitoringSetupError,
  runHostMonitoringSetup,
} from "../scripts/host-monitoring-setup.mjs";

async function fixture({ kind = "mac" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "devhub-host-monitoring-"));
  const catalogDirectory = path.join(root, "catalog");
  const projectDirectory = path.join(catalogDirectory, "projects");
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(path.join(catalogDirectory, "hosts.yaml"), `version: 1
hosts:
  - id: example-mac
    name: Example Mac
    kind: ${kind}
    location: local
    tailscaleName: example-mac
`);
  const projectPath = path.join(projectDirectory, "example.yaml");
  await writeFile(projectPath, `version: 1
id: example
title: Example
registration: overlay
description: Example service.
lifecycle: active
kind: product
services:
  - id: web
    name: Web
    kind: web
    environment: local
    host: example-mac
    runtime: node
    mode: always-on
    visibility: local
    probe:
      type: http
      url: https://example-mac.example.test/health/example
      successStatuses: [200]
      timeoutMs: 1000
      publish:
        type: tailscale-serve
        visibility: tailnet
        targetUrl: http://127.0.0.1:3000/api/health
        path: /health/example
`);
  return {
    root,
    paths: {
      root,
      catalogDirectory,
      hostsPath: path.join(catalogDirectory, "hosts.yaml"),
      projectDirectory,
      connectionProfilesPath: path.join(root, "profiles.json"),
      generatedOutputs: [],
    },
    projectPath,
  };
}

function fakeTailscale({ target = null, dnsName = "example-mac.example.test." } = {}) {
  const handlers = { "/unrelated": { Proxy: "http://127.0.0.1:9999/health" } };
  if (target) handlers["/health/example"] = { Proxy: target };
  const calls = [];
  const run = async (_file, args) => {
    calls.push([...args]);
    if (args[0] === "status") {
      return { stdout: JSON.stringify({ Self: { DNSName: dnsName, TailscaleIPs: [], Online: true } }) };
    }
    if (args[0] === "serve" && args[1] === "status") {
      return { stdout: JSON.stringify({ Web: { "example-mac.example.test:443": { Handlers: handlers } } }) };
    }
    if (args[0] === "serve" && args.at(-1) === "off") {
      delete handlers[args.find((argument) => argument.startsWith("--set-path=")).slice("--set-path=".length)];
      return { stdout: "" };
    }
    if (args[0] === "serve" && args.includes("--bg")) {
      const routePath = args.find((argument) => argument.startsWith("--set-path=")).slice("--set-path=".length);
      handlers[routePath] = { Proxy: args.at(-1) };
      return { stdout: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  return { calls, handlers, run };
}

const fetchUp = async () => ({ status: 200 });

test("setup-host-monitoring supports reviewed macOS, Windows and Linux hosts but rejects cloud publishers", async () => {
  for (const kind of ["mac", "windows", "linux"]) {
    const data = await fixture({ kind });
    const tailscale = fakeTailscale();
    try {
      const { result } = await runHostMonitoringSetup(data.root, ["example-mac"], {
        paths: data.paths,
        tailscaleBinary: "/example/tailscale",
        run: tailscale.run,
        fetch: fetchUp,
        environment: {},
      });
      assert.equal(result.host.kind, kind);
      assert.equal(result.centralVerification.state, "pending");
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  }

  const cloud = await fixture({ kind: "cloud" });
  try {
    await assert.rejects(
      runHostMonitoringSetup(cloud.root, ["example-mac"], {
        paths: cloud.paths,
        tailscaleBinary: "/example/tailscale",
        run: async () => { throw new Error("must not run"); },
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "host-unsupported",
    );
  } finally {
    await rm(cloud.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring dry-run plans only reviewed paths", async () => {
  const data = await fixture();
  const tailscale = fakeTailscale();
  try {
    const { result } = await runHostMonitoringSetup(data.root, ["example-mac"], {
      paths: data.paths,
      tailscaleBinary: "/example/tailscale",
      run: tailscale.run,
      fetch: fetchUp,
      environment: {},
    });
    assert.equal(result.readOnly, true);
    assert.equal(result.status, "changes-planned");
    assert.equal(result.routes[0].routeState, "pending");
    assert.equal(result.routes[0].target.state, "up");
    assert.deepEqual(result.routes[0].applyInvocation, {
      file: "/example/tailscale",
      args: ["serve", "--bg", "--https=443", "--set-path=/health/example", "http://127.0.0.1:3000/api/health"],
    });
    assert.deepEqual(result.routes[0].rollbackInvocation, {
      file: "/example/tailscale",
      args: ["serve", "--https=443", "--set-path=/health/example", "off"],
    });
    assert.equal(result.safety.funnel, false);
    assert.equal(result.safety.serveReset, false);
    assert.deepEqual(Object.keys(tailscale.handlers), ["/unrelated"]);
    assert.ok(tailscale.calls.every((args) => !args.includes("--bg")));
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring apply is path-scoped, preserves existing routes and becomes idempotent", async () => {
  const data = await fixture();
  const tailscale = fakeTailscale();
  try {
    const applied = await runHostMonitoringSetup(data.root, ["example-mac", "--apply"], {
      paths: data.paths,
      tailscaleBinary: "/example/tailscale",
      run: tailscale.run,
      fetch: fetchUp,
      environment: {},
    });
    assert.equal(applied.result.status, "applied");
    assert.deepEqual(applied.result.applied, ["example/web"]);
    assert.equal(tailscale.handlers["/unrelated"].Proxy, "http://127.0.0.1:9999/health");
    assert.equal(tailscale.handlers["/health/example"].Proxy, "http://127.0.0.1:3000/api/health");
    assert.ok(tailscale.calls.some((args) => args.join("\0") === [
      "serve", "--bg", "--https=443", "--set-path=/health/example", "http://127.0.0.1:3000/api/health",
    ].join("\0")));

    const applyCallsBefore = tailscale.calls.filter((args) => args.includes("--bg")).length;
    const repeated = await runHostMonitoringSetup(data.root, ["example-mac", "--apply"], {
      paths: data.paths,
      tailscaleBinary: "/example/tailscale",
      run: tailscale.run,
      fetch: fetchUp,
      environment: {},
    });
    assert.equal(repeated.result.status, "applied");
    assert.deepEqual(repeated.result.applied, []);
    assert.equal(tailscale.calls.filter((args) => args.includes("--bg")).length, applyCallsBefore);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring blocks route and device identity conflicts without mutation", async () => {
  const data = await fixture();
  try {
    const conflict = fakeTailscale({ target: "http://127.0.0.1:4000/wrong" });
    await assert.rejects(
      runHostMonitoringSetup(data.root, ["example-mac", "--apply"], {
        paths: data.paths,
        tailscaleBinary: "/example/tailscale",
        run: conflict.run,
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "tailscale-serve-conflict",
    );
    assert.equal(conflict.handlers["/health/example"].Proxy, "http://127.0.0.1:4000/wrong");

    const otherDevice = fakeTailscale({ dnsName: "other-mac.example.test." });
    await assert.rejects(
      runHostMonitoringSetup(data.root, ["example-mac"], {
        paths: data.paths,
        tailscaleBinary: "/example/tailscale",
        run: otherDevice.run,
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "tailscale-identity-conflict",
    );
    assert.ok(otherDevice.calls.every((args) => !args.includes("--bg")));
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring never overwrites an existing non-proxy Serve handler", async () => {
  const data = await fixture();
  const tailscale = fakeTailscale();
  tailscale.handlers["/health/example"] = { Path: "/srv/existing" };
  try {
    const preview = await runHostMonitoringSetup(data.root, ["example-mac"], {
      paths: data.paths,
      tailscaleBinary: "/example/tailscale",
      run: tailscale.run,
      fetch: fetchUp,
      environment: {},
    });
    assert.equal(preview.result.status, "blocked");
    assert.equal(preview.result.routes[0].routeState, "conflict");
    assert.equal(preview.result.routes[0].currentTarget, "non-proxy-handler");

    await assert.rejects(
      runHostMonitoringSetup(data.root, ["example-mac", "--apply"], {
        paths: data.paths,
        tailscaleBinary: "/example/tailscale",
        run: tailscale.run,
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "tailscale-serve-conflict",
    );
    assert.deepEqual(tailscale.handlers["/health/example"], { Path: "/srv/existing" });
    assert.ok(tailscale.calls.every((args) => !args.includes("--bg")));
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring rejects duplicate reviewed path ownership", async () => {
  const data = await fixture();
  const tailscale = fakeTailscale();
  try {
    await appendFile(data.projectPath, `  - id: worker
    name: Worker
    kind: worker
    environment: local
    host: example-mac
    runtime: node
    mode: always-on
    visibility: internal
    probe:
      type: http
      url: https://example-mac.example.test/health/example
      successStatuses: [200]
      publish:
        type: tailscale-serve
        visibility: tailnet
        targetUrl: http://127.0.0.1:3000/api/health
        path: /health/example
`);
    await assert.rejects(
      runHostMonitoringSetup(data.root, ["example-mac"], {
        paths: data.paths,
        tailscaleBinary: "/example/tailscale",
        run: tailscale.run,
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "reviewed-route-conflict",
    );
    assert.equal(tailscale.calls.length, 0);
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring refuses unreachable and unexpected pending targets", async () => {
  for (const fetch of [
    async () => ({ status: 503 }),
    async () => { throw new Error("offline"); },
  ]) {
    const data = await fixture();
    const tailscale = fakeTailscale();
    try {
      await assert.rejects(
        runHostMonitoringSetup(data.root, ["example-mac", "--apply"], {
          paths: data.paths,
          tailscaleBinary: "/example/tailscale",
          run: tailscale.run,
          fetch,
          environment: {},
        }),
        (error) => error instanceof HostMonitoringSetupError && error.code === "host-monitoring-target-unhealthy",
      );
      assert.equal(tailscale.handlers["/health/example"], undefined);
      assert.ok(tailscale.calls.every((args) => !args.includes("--bg")));
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  }
});

test("setup-host-monitoring apply does not claim verification for a current route with a dead target", async () => {
  const reviewedTarget = "http://127.0.0.1:3000/api/health";
  const data = await fixture();
  const tailscale = fakeTailscale({ target: reviewedTarget });
  try {
    await assert.rejects(
      runHostMonitoringSetup(data.root, ["example-mac", "--apply"], {
        paths: data.paths,
        tailscaleBinary: "/example/tailscale",
        run: tailscale.run,
        fetch: async () => { throw new Error("offline"); },
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "host-monitoring-target-unhealthy",
    );
    assert.equal(tailscale.handlers["/health/example"].Proxy, reviewedTarget);
    assert.ok(tailscale.calls.every((args) => !args.includes("--bg")));
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring apply is locked and rolls back only newly added paths on verification failure", async () => {
  const lockedData = await fixture();
  const lockedTailscale = fakeTailscale();
  const hostLockPath = path.join(os.tmpdir(), "devhub-host-monitoring-example-mac.lock");
  try {
    await rm(hostLockPath, { force: true });
    await writeFile(hostLockPath, "held\n");
    await assert.rejects(
      runHostMonitoringSetup(lockedData.root, ["example-mac", "--apply"], {
        paths: lockedData.paths,
        tailscaleBinary: "/example/tailscale",
        run: lockedTailscale.run,
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "host-monitoring-locked",
    );
    assert.ok(lockedTailscale.calls.every((args) => !args.includes("--bg")));

    await rm(hostLockPath, { force: true });
    await writeFile(hostLockPath, `${JSON.stringify({
      pid: 2_147_483_647,
      host: os.hostname(),
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`);
    await assert.rejects(
      runHostMonitoringSetup(lockedData.root, ["example-mac", "--apply"], {
        paths: lockedData.paths,
        tailscaleBinary: "/example/tailscale",
        run: lockedTailscale.run,
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "host-monitoring-locked",
    );
  } finally {
    await rm(hostLockPath, { force: true });
    await rm(lockedData.root, { recursive: true, force: true });
  }

  const rollbackData = await fixture();
  const rollbackTailscale = fakeTailscale();
  let serveStatusCalls = 0;
  const failVerification = async (file, args) => {
    if (args[0] === "serve" && args[1] === "status" && ++serveStatusCalls === 5) {
      return { stdout: JSON.stringify({ Web: {
        "example-mac.example.test:443": {
          Handlers: { "/unrelated": { Proxy: "http://127.0.0.1:9999/health" } },
        },
      } }) };
    }
    return rollbackTailscale.run(file, args);
  };
  try {
    await assert.rejects(
      runHostMonitoringSetup(rollbackData.root, ["example-mac", "--apply"], {
        paths: rollbackData.paths,
        tailscaleBinary: "/example/tailscale",
        run: failVerification,
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "tailscale-serve-verification-failed",
    );
    assert.equal(rollbackTailscale.handlers["/health/example"], undefined);
    assert.equal(rollbackTailscale.handlers["/unrelated"].Proxy, "http://127.0.0.1:9999/health");
  } finally {
    await rm(rollbackData.root, { recursive: true, force: true });
  }

  const targetData = await fixture();
  const targetTailscale = fakeTailscale();
  let targetChecks = 0;
  const targetFailsAfterApply = async () => {
    targetChecks += 1;
    if (targetChecks === 4) throw new Error("target stopped");
    return { status: 200 };
  };
  try {
    await assert.rejects(
      runHostMonitoringSetup(targetData.root, ["example-mac", "--apply"], {
        paths: targetData.paths,
        tailscaleBinary: "/example/tailscale",
        run: targetTailscale.run,
        fetch: targetFailsAfterApply,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "tailscale-serve-verification-failed",
    );
    assert.equal(targetTailscale.handlers["/health/example"], undefined);
    assert.equal(targetTailscale.handlers["/unrelated"].Proxy, "http://127.0.0.1:9999/health");
  } finally {
    await rm(targetData.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring never removes a lock whose ownership changed", async () => {
  const data = await fixture();
  const tailscale = fakeTailscale();
  const hostLockPath = path.join(os.tmpdir(), "devhub-host-monitoring-example-mac.lock");
  const replacement = `${JSON.stringify({ nonce: "replacement-owner", pid: 42, host: os.hostname() })}\n`;
  const replaceLockAfterWrite = async (file, args) => {
    const result = await tailscale.run(file, args);
    if (args.includes("--bg")) await writeFile(hostLockPath, replacement);
    return result;
  };
  try {
    await rm(hostLockPath, { force: true });
    await assert.rejects(
      runHostMonitoringSetup(data.root, ["example-mac", "--apply"], {
        paths: data.paths,
        tailscaleBinary: "/example/tailscale",
        run: replaceLockAfterWrite,
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "host-monitoring-lock-ownership-lost",
    );
    assert.equal(await readFile(hostLockPath, "utf8"), replacement);
  } finally {
    await rm(hostLockPath, { force: true });
    await rm(data.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring compensates mutate-then-error and preserves externally reassigned paths", async () => {
  const mutatedData = await fixture();
  const mutatedTailscale = fakeTailscale();
  const mutateThenError = async (file, args) => {
    const result = await mutatedTailscale.run(file, args);
    if (args.includes("--bg")) throw new Error("command response lost after mutation");
    return result;
  };
  try {
    await assert.rejects(
      runHostMonitoringSetup(mutatedData.root, ["example-mac", "--apply"], {
        paths: mutatedData.paths,
        tailscaleBinary: "/example/tailscale",
        run: mutateThenError,
        fetch: fetchUp,
        environment: {},
      }),
      /command response lost after mutation/,
    );
    assert.equal(mutatedTailscale.handlers["/health/example"], undefined);
    assert.equal(mutatedTailscale.handlers["/unrelated"].Proxy, "http://127.0.0.1:9999/health");
  } finally {
    await rm(mutatedData.root, { recursive: true, force: true });
  }

  const reassignedData = await fixture();
  const reassignedTailscale = fakeTailscale();
  const reassignAfterWrite = async (file, args) => {
    const result = await reassignedTailscale.run(file, args);
    if (args.includes("--bg")) {
      reassignedTailscale.handlers["/health/example"] = { Proxy: "http://127.0.0.1:4000/external" };
    }
    return result;
  };
  try {
    await assert.rejects(
      runHostMonitoringSetup(reassignedData.root, ["example-mac", "--apply"], {
        paths: reassignedData.paths,
        tailscaleBinary: "/example/tailscale",
        run: reassignAfterWrite,
        fetch: fetchUp,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "host-monitoring-rollback-incomplete",
    );
    assert.equal(reassignedTailscale.handlers["/health/example"].Proxy, "http://127.0.0.1:4000/external");
  } finally {
    await rm(reassignedData.root, { recursive: true, force: true });
  }
});

test("setup-host-monitoring rechecks path ownership after the local health request", async () => {
  const data = await fixture();
  const tailscale = fakeTailscale();
  let targetChecks = 0;
  const fetchWithExternalClaim = async () => {
    targetChecks += 1;
    if (targetChecks === 3) {
      tailscale.handlers["/health/example"] = { Proxy: "http://127.0.0.1:4000/external" };
    }
    return { status: 200 };
  };
  try {
    await assert.rejects(
      runHostMonitoringSetup(data.root, ["example-mac", "--apply"], {
        paths: data.paths,
        tailscaleBinary: "/example/tailscale",
        run: tailscale.run,
        fetch: fetchWithExternalClaim,
        environment: {},
      }),
      (error) => error instanceof HostMonitoringSetupError && error.code === "tailscale-serve-conflict",
    );
    assert.equal(tailscale.handlers["/health/example"].Proxy, "http://127.0.0.1:4000/external");
    assert.ok(tailscale.calls.every((args) => !args.includes("--bg")));
  } finally {
    await rm(data.root, { recursive: true, force: true });
  }
});
