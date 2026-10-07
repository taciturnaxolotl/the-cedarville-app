/**
 * Three artifacts from one source tree:
 *   dist/    the extension, loaded unpacked in chrome://extensions
 *   public/  the planner, a static page served by `bun run serve`
 *   public/cedarville-bridge.zip  the same extension, to be downloaded
 *
 * The zip is how a hosted planner hands the extension to a student. Chrome
 * refuses to install one from a web page — no `.crx` over HTTP since version
 * 75, and dragging one in is refused too — so the only route that does not
 * go through the Web Store is "load unpacked", and what gets loaded is a
 * folder. A folder travels as a zip.
 *
 * They share the raw Colleague types and nothing else. The extension fetches;
 * the page interprets.
 *
 * The app's origin is baked in here rather than read at runtime, because a
 * manifest has to name it literally — an extension cannot be told at startup
 * which sites may ask it for a transcript. Build for a deployment with
 * `APP_ORIGIN=https://plan.example.edu bun run build`.
 */

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { APP_ORIGIN, COMPANION } from "./src/where";
import { zip } from "./src/zip";

/** What the extension calls itself, which the page compares against. */
const VERSION = ((await Bun.file("src/manifest.json").json()) as { version: string }).version;

const watch = process.argv.includes("--watch");

/** What a student downloads. Named so it is recognisable in ~/Downloads. */
const BUNDLE = "cedarville-bridge.zip";

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
      // The page is built knowing which extension it was built against, so
      // it can say "yours is older than this planner" rather than failing in
      // a way that reads as the planner being broken.
      "process.env.BRIDGE_VERSION": JSON.stringify(VERSION),
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

/**
 * The extension, archived for download.
 *
 * Built after `dist` and written into `public`, so the planner serves the
 * exact bundle it was built alongside. Sorted by name rather than by whatever
 * order the directory came back in, because an archive that reshuffles itself
 * between builds is a fresh download for everyone who already has it.
 */
async function archive(): Promise<number> {
  const names = (await readdir("dist")).sort();
  const entries = await Promise.all(
    names.map(async (name) => ({
      name,
      data: new Uint8Array(await Bun.file(`dist/${name}`).arrayBuffer()),
    })),
  );
  const bytes = zip(entries);
  await Bun.write(`public/${BUNDLE}`, bytes);
  return bytes.length;
}

async function build() {
  await bundle(["src/content.ts", "src/background.ts"], "dist", []);
  await Bun.write("dist/manifest.json", await manifest());
  await bundle(["src/client/app.ts", "src/client/install.ts"], "public", [
    ["src/client/index.html", "index.html"],
    ["src/client/install.html", "install.html"],
    ["src/client/app.css", "app.css"],
  ]);
  const size = await archive();
  console.log(
    `built dist/ (extension ${VERSION}), public/ (planner) and ${BUNDLE} ` +
      `(${(size / 1024).toFixed(0)}kb) for ${APP_ORIGIN}`,
  );
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
