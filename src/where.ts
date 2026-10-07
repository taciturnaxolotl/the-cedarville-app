/**
 * Who is allowed to talk to whom, in one place.
 *
 * Three parties, and only two of them are ever on the network. The catalog
 * server is public and deployable: it holds course data that is identical for
 * every student. The companion is loopback only and holds the one thing that
 * is personal. The extension is the only party that has both, and it is the
 * only one that may hand a capture across.
 *
 * The app origin is a build-time value because the extension manifest has to
 * name it literally: `APP_ORIGIN=https://plan.example.edu bun run build`.
 */

/** Where the planner page is served from. */
export const APP_ORIGIN = process.env.APP_ORIGIN || "http://localhost:5173";

/**
 * The extension's own id, pinned by the `key` field in the manifest so it is
 * the same on every machine. The companion checks it: a page cannot forge an
 * `Origin` header, so this is what keeps the port from being an open door for
 * anything else that happens to be running in the browser.
 */
export const EXTENSION_ID = "dijggphdklmdeegidljleaogedbahpjo";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/**
 * The loopback port the local companion listens on.
 *
 * 127.0.0.1 rather than localhost: the name can resolve to something else,
 * and this is the one hop a student's transcript is allowed to make.
 */
export const COMPANION_PORT = Number(process.env.CEDARVILLE_PORT || 7749);
export const COMPANION = `http://127.0.0.1:${COMPANION_PORT}`;
