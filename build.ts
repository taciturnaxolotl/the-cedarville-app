/**
 * Two artifacts from one source tree:
 *   dist/    the extension, loaded unpacked in chrome://extensions
 *   public/  the planner, a static page served by `bun run serve`
 *
 * They share the raw Colleague types and nothing else. The extension fetches;
 * the page interprets.
 */

import { cp, mkdir, rm } from "node:fs/promises";

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
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  for (const [from, to] of assets) await cp(from, `${outdir}/${to}`);
}

async function build() {
  await bundle(["src/content.ts", "src/background.ts"], "dist", [
    ["src/manifest.json", "manifest.json"],
  ]);
  await bundle(["src/client/app.ts"], "public", [
    ["src/client/index.html", "index.html"],
    ["src/client/app.css", "app.css"],
  ]);
  console.log("built dist/ (extension) and public/ (planner)");
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
