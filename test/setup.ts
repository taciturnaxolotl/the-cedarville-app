/*
 * Loaded before every test file (see bunfig.toml).
 *
 * Its one job is to make it impossible for a test to touch the real catalog
 * database. CatalogStore defaults to .data/catalog.sqlite, so a single import
 * of serve.ts from a test would open, and possibly write, live data. Forcing
 * the default to :memory: here means that mistake cannot be made rather than
 * merely being discouraged.
 */

process.env.CATALOG_DB = ":memory:";
