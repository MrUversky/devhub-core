import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 150;

function boundedInteger(value, fallback, label) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > 16 * 1024 * 1024) {
    throw new TypeError(`${label} must be a bounded positive integer`);
  }
  return resolved;
}

function minimalChildEnvironment() {
  const environment = {
    PATH: process.platform === "win32"
      ? "C:\\Windows\\System32;C:\\Windows"
      : "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };
  if (process.platform === "win32" && process.env.SystemRoot) environment.SystemRoot = process.env.SystemRoot;
  return environment;
}

function signalProcessTree(child, signal) {
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH" && child.exitCode === null && child.signalCode === null) child.kill(signal);
      return;
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function processGroupExists(child) {
  if (process.platform === "win32" || !Number.isInteger(child.pid)) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runIsolatedJsonChild(options = {}) {
  const childPath = options.childPath;
  if (typeof childPath !== "string" || !path.isAbsolute(childPath)) {
    throw new TypeError("isolated JSON child path must be absolute");
  }
  const maxInputBytes = boundedInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES, "isolated JSON max input bytes");
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "isolated JSON max output bytes");
  const maxStderrBytes = boundedInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES, "isolated JSON max stderr bytes");
  const terminationGraceMs = boundedInteger(options.terminationGraceMs, DEFAULT_TERMINATION_GRACE_MS, "isolated JSON termination grace");
  const timeoutMs = options.timeoutMs === undefined ? null : boundedInteger(options.timeoutMs, 1, "isolated JSON timeout");
  const input = typeof options.input === "string" ? options.input : `${JSON.stringify(options.input)}\n`;
  if (Buffer.byteLength(input, "utf8") > maxInputBytes) throw new TypeError("isolated JSON child input is too large");
  if (options.signal?.aborted) return Object.freeze({ state: "aborted", stdout: "" });

  const child = spawn(process.execPath, [childPath], {
    cwd: path.parse(childPath).root,
    env: minimalChildEnvironment(),
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  return new Promise((resolve) => {
    let stdout = "";
    let stderrBytes = 0;
    let invalidOutput = false;
    let spawnFailed = false;
    let terminationReason = null;
    let killTimer = null;
    let timeout = null;
    let groupPoll = null;
    let forceSentAt = null;
    let closeCode = null;
    let childClosed = false;
    let resolved = false;

    const finish = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      const state = terminationReason === "aborted" && options.signal?.aborted && !invalidOutput && !spawnFailed
        ? "aborted"
        : terminationReason === "timed-out" && !invalidOutput && !spawnFailed
          ? "timed-out"
          : !terminationReason && !spawnFailed && !invalidOutput && closeCode === 0
            ? "completed"
            : "unavailable";
      resolve(Object.freeze({ state, stdout: state === "completed" ? stdout : "" }));
    };

    const awaitTerminatedGroup = () => {
      if (!childClosed) return;
      if (!processGroupExists(child)) {
        finish();
        return;
      }
      if (forceSentAt !== null && Date.now() - forceSentAt >= 1_000) {
        finish();
        return;
      }
      if (!groupPoll) {
        groupPoll = setTimeout(() => {
          groupPoll = null;
          awaitTerminatedGroup();
        }, 10);
      }
    };

    const requestTermination = (reason) => {
      if (!terminationReason) terminationReason = reason;
      signalProcessTree(child, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => {
          forceSentAt = Date.now();
          signalProcessTree(child, "SIGKILL");
          awaitTerminatedGroup();
        }, terminationGraceMs);
      }
    };
    const abort = () => requestTermination("aborted");
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (timeout) clearTimeout(timeout);
      if (groupPoll) clearTimeout(groupPoll);
      options.signal?.removeEventListener?.("abort", abort);
    };

    options.signal?.addEventListener?.("abort", abort, { once: true });
    if (timeoutMs !== null) {
      timeout = setTimeout(() => requestTermination("timed-out"), timeoutMs);
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
        invalidOutput = true;
        requestTermination("invalid-output");
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) {
        invalidOutput = true;
        requestTermination("invalid-output");
      }
    });
    child.once("error", () => { spawnFailed = true; });
    child.stdin.once("error", () => {
      if (!terminationReason) {
        invalidOutput = true;
        requestTermination("invalid-output");
      }
    });
    child.once("close", (code) => {
      childClosed = true;
      closeCode = code;
      if (terminationReason) awaitTerminatedGroup();
      else finish();
    });
    child.stdin.end(input);
    if (options.signal?.aborted) abort();
  });
}
