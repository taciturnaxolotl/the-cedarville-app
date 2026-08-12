/**
 * The section catalog for one term.
 *
 * This is the one thing in the project that is *not* personal. Meeting times,
 * seat counts and instructors are identical for every student at the school,
 * which is why it can be cached and shared while a transcript never can. The
 * boundary is worth stating plainly: catalog on the server, record in the
 * browser.
 */

import type { SectionsResponse } from "./types";

export interface TermCatalog {
  term: string;
  /** When these sections were fetched from Self-Service. */
  fetchedAt: string;
  /** Raw responses keyed by course id, so a normalizer bug stays diagnosable. */
  sections: Record<string, SectionsResponse>;
  /** Course ids confirmed to have no section this term. Worth caching too. */
  notOffered: string[];
}

export const emptyCatalog = (term: string): TermCatalog => ({
  term,
  fetchedAt: new Date().toISOString(),
  sections: {},
  notOffered: [],
});

/** Course ids the catalog can already answer for, offered or not. */
export function known(catalog: TermCatalog): Set<string> {
  return new Set([...Object.keys(catalog.sections), ...catalog.notOffered]);
}

/**
 * Later data wins, since the only reason to refetch a course is that the
 * cached copy went stale.
 */
export function mergeCatalogs(base: TermCatalog, incoming: TermCatalog): TermCatalog {
  const notOffered = new Set(base.notOffered);
  for (const id of incoming.notOffered) notOffered.add(id);

  const sections = { ...base.sections, ...incoming.sections };
  // A course that now has sections is no longer "not offered".
  for (const id of Object.keys(incoming.sections)) notOffered.delete(id);

  return {
    term: base.term,
    fetchedAt: incoming.fetchedAt > base.fetchedAt ? incoming.fetchedAt : base.fetchedAt,
    sections,
    notOffered: [...notOffered],
  };
}

/**
 * Seat counts move hourly during registration while meeting times do not, so
 * age is only a reason to refetch availability, never the whole catalog.
 */
export function ageInHours(catalog: TermCatalog, now = Date.now()): number {
  return (now - Date.parse(catalog.fetchedAt)) / 3_600_000;
}
