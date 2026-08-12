/**
 * The shared section cache.
 *
 * A database here is not a walking back of "nothing is stored server-side".
 * The rule was never "no storage", it was "no student records", and section
 * times, seats and instructors are identical for every student at the school.
 * Caching them is what stops fifty students each firing two hundred requests
 * at the registrar for byte-identical answers.
 *
 * Nothing student-shaped may enter this file. No evaluations, no transcripts,
 * no ids.
 */

import { Database } from "bun:sqlite";
import type { TermCatalog } from "../catalog";
import type { SectionsResponse } from "../types";

/**
 * Rows are per course, not per term, because that is the unit that goes
 * stale: seat counts move hourly during registration while meeting times sit
 * still for months.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sections (
  term       TEXT NOT NULL,
  course_id  TEXT NOT NULL,
  offered    INTEGER NOT NULL,
  payload    TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (term, course_id)
) STRICT;
`;

export class CatalogStore {
  #db: Database;

  /**
   * The default is overridable by CATALOG_DB, which the test preload pins to
   * ":memory:" so no test can reach the real database.
   */
  constructor(path = process.env.CATALOG_DB ?? ".data/catalog.sqlite") {
    this.#db = new Database(path, { create: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA);
  }

  /** Everything cached for a term, optionally narrowed to courses we want. */
  read(term: string, courseIds?: string[]): TermCatalog {
    const rows = courseIds?.length
      ? this.#db
          .query<Row, [string, string]>(
            `SELECT * FROM sections WHERE term = ? AND course_id IN (SELECT value FROM json_each(?))`,
          )
          .all(term, JSON.stringify(courseIds))
      : this.#db.query<Row, [string]>(`SELECT * FROM sections WHERE term = ?`).all(term);

    const catalog: TermCatalog = {
      term,
      fetchedAt: new Date(0).toISOString(),
      sections: {},
      notOffered: [],
    };

    for (const row of rows) {
      if (row.fetched_at > catalog.fetchedAt) catalog.fetchedAt = row.fetched_at;
      if (row.offered && row.payload) {
        catalog.sections[row.course_id] = JSON.parse(row.payload) as SectionsResponse;
      } else {
        catalog.notOffered.push(row.course_id);
      }
    }
    return catalog;
  }

  /** Upserts a crawl's results. Later fetches win. */
  write(catalog: TermCatalog): number {
    const upsert = this.#db.query(
      `INSERT INTO sections (term, course_id, offered, payload, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(term, course_id) DO UPDATE SET
         offered = excluded.offered,
         payload = excluded.payload,
         fetched_at = excluded.fetched_at
       WHERE excluded.fetched_at >= sections.fetched_at`,
    );

    const all = this.#db.transaction(() => {
      let n = 0;
      for (const [courseId, payload] of Object.entries(catalog.sections)) {
        upsert.run(catalog.term, courseId, 1, JSON.stringify(payload), catalog.fetchedAt);
        n++;
      }
      for (const courseId of catalog.notOffered) {
        upsert.run(catalog.term, courseId, 0, null, catalog.fetchedAt);
        n++;
      }
      return n;
    });
    return all();
  }

  stats(): { term: string; courses: number; offered: number; oldest: string }[] {
    return this.#db
      .query<StatRow, []>(
        `SELECT term,
                COUNT(*) AS courses,
                SUM(offered) AS offered,
                MIN(fetched_at) AS oldest
         FROM sections GROUP BY term ORDER BY term`,
      )
      .all();
  }

  close() {
    this.#db.close();
  }
}

interface Row {
  term: string;
  course_id: string;
  offered: number;
  payload: string | null;
  fetched_at: string;
}

interface StatRow {
  term: string;
  courses: number;
  offered: number;
  oldest: string;
}
