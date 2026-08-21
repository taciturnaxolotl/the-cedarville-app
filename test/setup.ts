/*
 * Loaded before every test file (see bunfig.toml).
 *
 * Its job is to make it impossible for a test to touch real data. CatalogStore defaults to .data/catalog.sqlite, so a single import
 * of serve.ts from a test would open, and possibly write, live data. Forcing
 * the default to :memory: here means that mistake cannot be made rather than
 * merely being discouraged.
 */

process.env.CATALOG_DB = ":memory:";

/**
 * And the same for a transcript. `readCapture` falls back to the repo's own
 * `.data/evaluations.json`, which on a machine that has run the planner is a
 * real student's record. Naming a path that does not exist turns that
 * fallback off, so no test can read one by accident.
 */
process.env.CEDARVILLE_CAPTURE = "/nonexistent/cedarville-tests/evaluations.json";
