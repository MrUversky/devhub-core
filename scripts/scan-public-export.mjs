#!/usr/bin/env node
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const localFingerprintFile = path.join(sourceRoot, "config/public-export-deny-patterns.txt");
const defaultFingerprintFile = existsSync(localFingerprintFile) ? localFingerprintFile : null;
const maxFileBytes = 8 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textExtensions = new Set([
  ".cjs", ".css", ".example", ".html", ".js", ".json", ".md", ".mdc", ".mjs", ".mts",
  ".svg", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml",
]);
const allowedBinaryFiles = new Map([
  ["public/devhub-preview.png", "png"],
  ["public/og.png", "png"],
]);
// This one public repository coordinate is part of the community install
// contract. Mask only the complete owner/repository literal before applying
// private-instance fingerprints; the same owner token in any other context
// remains blocked.
const approvedPublicReferences = Object.freeze(["MrUversky/devhub-core"]);
const genericPatterns = [
  { label: "absolute macOS home path", pattern: /\/Users\/[^/\s"']+/i },
  { label: "absolute Linux home path", pattern: /(?:^|[\s"'(=])\/(?:home\/[^/\s"']+|root)(?:\/[^\s"']*)?/i },
  { label: "absolute Windows home path", pattern: /\b[A-Z]:\\Users\\[^\\\s"']+/i },
  { label: "Tailscale CGNAT address", pattern: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2}\b/ },
  { label: "Tailscale MagicDNS hostname", pattern: /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i },
  { label: "private key material", pattern: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH) )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----/i },
  { label: "authorization bearer token", pattern: /\bauthorization\s*[:=]\s*["']?bearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { label: "secret-bearing assignment", pattern: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|password|secret|token)\s*[:=]\s*["']?(?!(?:process|deno|bun)\.env\b|os\.environ\b|env\.|\$\{)[A-Za-z0-9_./+=-]{16,}/i },
  { label: "secret-bearing URL query", pattern: /[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|token)=[^&#\s]{8,}/i },
  { label: "credential-bearing connection URL", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/:@]+:[^\s/@]+@/i },
  { label: "GitHub token", pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/ },
  { label: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
];

function compareCodepoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(relative) {
  return relative.split(path.sep).join("/");
}

function isTextPath(relative) {
  const basename = path.posix.basename(relative);
  return path.posix.extname(basename) === "" || textExtensions.has(path.posix.extname(basename).toLowerCase());
}

function hasPngSignature(buffer) {
  const expected = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buffer.length >= expected.length && buffer.subarray(0, expected.length).equals(expected);
}

function scanValue(value, location, fingerprints, errors, { generic = true } = {}) {
  const folded = value.toLocaleLowerCase("en-US");
  for (const fingerprint of fingerprints) {
    if (folded.includes(fingerprint.folded)) {
      errors.push(`${location}: contains private fingerprint ${JSON.stringify(fingerprint.original)}`);
    }
  }
  if (generic) {
    for (const item of genericPatterns) {
      if (item.pattern.test(value)) errors.push(`${location}: contains ${item.label}`);
    }
  }
}

function genericScanContents(relative, contents) {
  if (relative !== "scripts/scan-public-export.mjs") return contents;
  const start = contents.indexOf("const genericPatterns = [");
  const end = contents.indexOf("\n];", start);
  if (start < 0 || end < 0) throw new Error("Public export scanner cannot isolate its generic pattern declarations.");
  return `${contents.slice(0, start)}${contents.slice(end + 3)}`;
}

function fingerprintScanContents(contents) {
  return approvedPublicReferences.reduce(
    (sanitized, reference) => {
      const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return sanitized.replace(
        new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9_.-])`, "g"),
        "<approved-public-repository>",
      );
    },
    contents,
  );
}

async function readFingerprints(filename) {
  if (!filename) return [];
  return (await readFile(filename, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((original) => ({ original, folded: original.toLocaleLowerCase("en-US") }));
}

async function collectFiles(root, errors) {
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Public export scan root must be a real directory.");
  }

  const files = [];
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareCodepoints(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        errors.push(`${relative}: symbolic links are not allowed`);
      } else if (stat.isDirectory()) {
        await walk(absolute);
      } else if (stat.isFile()) {
        files.push({ absolute, relative, size: stat.size });
      } else {
        errors.push(`${relative}: special files are not allowed`);
      }
    }
  }
  await walk(root);
  return files;
}

export async function scanPublicExport(directory, { fingerprintFile = defaultFingerprintFile } = {}) {
  const root = path.resolve(directory);
  const errors = [];
  const fingerprints = await readFingerprints(fingerprintFile);
  const files = await collectFiles(root, errors);

  for (const file of files) {
    scanValue(file.relative, `${file.relative}: path`, fingerprints, errors);
    if (file.size > maxFileBytes) {
      errors.push(`${file.relative}: exceeds ${maxFileBytes} bytes`);
      continue;
    }

    const buffer = await readFile(file.absolute);
    const binaryType = allowedBinaryFiles.get(file.relative);
    if (binaryType) {
      if (binaryType === "png" && !hasPngSignature(buffer)) {
        errors.push(`${file.relative}: expected a PNG file`);
      }
      continue;
    }

    if (!isTextPath(file.relative)) {
      errors.push(`${file.relative}: unsupported binary or unknown file type`);
      continue;
    }

    let contents;
    try {
      contents = textDecoder.decode(buffer);
    } catch {
      errors.push(`${file.relative}: is not valid UTF-8 text`);
      continue;
    }
    if (contents.includes("\0")) {
      errors.push(`${file.relative}: contains binary NUL bytes`);
      continue;
    }
    // Mask only this scanner's own pattern declaration before applying those
    // patterns to the rest of the file. Private fingerprints still scan every
    // byte, and an unrelated secret added to this file remains detectable.
    scanValue(
      fingerprintScanContents(genericScanContents(file.relative, contents)),
      file.relative,
      fingerprints,
      errors,
    );
  }

  if (errors.length) throw new Error(`Public export rejected:\n- ${errors.join("\n- ")}`);
  return { files: files.length };
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  const target = process.argv[2];
  if (!target) throw new Error("Usage: node scripts/scan-public-export.mjs <export-directory>");
  const result = await scanPublicExport(target);
  console.log(`public export scan: clean (${result.files} files)`);
}
