#!/usr/bin/env bun

/*
 * Keeps a capture on your own machine.
 *
 * The extension posts every capture to a loopback port, and this is what
 * listens on it. Nothing else does: the port only opens when you run this,
 * so a student who never wants a transcript on disk simply never starts it.
 *
 *   bun run companion
 *
 * Nothing is lost when it is not running. The extension's post fails, the
 * planner carries on in the browser, and the scripts under scripts/ say which
 * file they were looking for.
 */

import { capturePath, picksPath, serveCompanion } from "../src/server/companion";

const companion = serveCompanion((path) => console.log(`wrote ${path}`));

if (!companion) {
  console.error(`something already holds the port; only one companion can listen`);
  process.exit(1);
}

console.log(`companion on 127.0.0.1:${companion.port}, for the extension only`);
console.log(`  capture  ${capturePath()}`);
console.log(`  picks    ${picksPath()}`);
