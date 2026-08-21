import { readFile } from "node:fs/promises";
import vinext from "vinext";
import { defineConfig } from "vite";
import { sites } from "./build/sites-vite-plugin.ts";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

async function readOptionalHostingConfig() {
  try {
    const parsed = JSON.parse(await readFile(new URL("./.openai/hosting.json", import.meta.url), "utf8"));
    return { d1: typeof parsed.d1 === "string" ? parsed.d1 : null, r2: typeof parsed.r2 === "string" ? parsed.r2 : null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { d1: null, r2: null };
    throw error;
  }
}

export default defineConfig(async () => {
  const { d1, r2 } = await readOptionalHostingConfig();
  const localBindingConfig = {
    main: "./worker/index.ts",
    compatibility_flags: ["nodejs_compat"],
    d1_databases: d1
      ? [{ binding: d1, database_name: "site-creator-d1", database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID }]
      : [],
    r2_buckets: r2
      ? [{ binding: r2, bucket_name: "site-creator-r2" }]
      : [],
  };
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
