/**
 * Two artifacts from one source tree:
 *   dist/    the extension, loaded unpacked in chrome://extensions
 *   public/  the planner, a static page served by `bun run serve`
 *
 * They share the raw Colleague types and nothing else. The extension fetches;
 * the page interprets.
 *
 * The app's origin is baked in here rather than read at runtime, because a
 * manifest has to name it literally — an extension cannot be told at startup
 * which sites may ask it for a transcript. Build for a deployment with
 * `APP_ORIGIN=https://plan.example.edu bun run build`.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { APP_ORIGIN, COMPANION } from "./src/where";

const watch = process.argv.includes("--watch");

async function bundle(entrypoints: string[], outdir: string, assets: [string, string][]) {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const result = await Bun.build({
    entrypoints,
    outdir,
    target: "browser",
    format: "esm",
    sourcemap: "linked",
    naming: "[name].js",
    // A browser has no process.env; these are the two addresses the bundles
    // need to know, and they are decided here.
    define: {
      "process.env.APP_ORIGIN": JSON.stringify(APP_ORIGIN),
      "process.env.CEDARVILLE_PORT": JSON.stringify(new URL(COMPANION).port),
    },
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  for (const [from, to] of assets) await cp(from, `${outdir}/${to}`);
}

/**
 * The manifest, told where the app lives.
 *
 * Localhost stays alongside the deployed origin so an unpacked development
 * build keeps working; both are origins the student installed this for.
 */
async function manifest(): Promise<string> {
  const source = (await Bun.file("src/manifest.json").json()) as {
    host_permissions: string[];
    externally_connectable: { matches: string[] };
  };
  const origins = [...new Set([`${APP_ORIGIN}/*`, "http://localhost:5173/*"])];
  return JSON.stringify(
    {
      ...source,
      host_permissions: [...new Set([...source.host_permissions, `${COMPANION}/*`])],
      externally_connectable: { matches: origins },
    },
    null,
    2,
  );
}

async function build() {
  await bundle(["src/content.ts", "src/background.ts"], "dist", []);
  await Bun.write("dist/manifest.json", await manifest());
  await bundle(["src/client/app.ts"], "public", [
    ["src/client/index.html", "index.html"],
    ["src/client/app.css", "app.css"],
  ]);
  console.log(`built dist/ (extension) and public/ (planner) for ${APP_ORIGIN}`);
}

await build();

if (watch) {
  const { watch: fsWatch } = await import("node:fs");
  let queued: ReturnType<typeof setTimeout> | undefined;
  fsWatch("src", { recursive: true }, () => {
    clearTimeout(queued);
    queued = setTimeout(() => build().catch(console.error), 50);
  });
  console.log("watching src/");
}
