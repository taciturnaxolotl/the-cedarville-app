/**
 * The shared section cache.
 *
 * A database here is not a walking back of "nothing is stored server-side".
 * The rule was never "no storage", it was "no student records", and section
 * times, seats and instructors are identical for every student at the school.
 * The server fetches them anonymously, so no one's session is spent on data
 * that is the same for everybody.
 *
 * Nothing student-shaped may enter this file. No evaluations, no transcripts,
 * no ids.
 */

import { Database } from "bun:sqlite";
import type { CatalogCourseRecord, ListingSection, TermCatalog } from "../catalog";

/**
 * Rows are per section, matching what the search endpoint returns, and carry
 * their own timestamp: seat counts move hourly during registration while
 * meeting times sit still for months.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sections (
  term       TEXT NOT NULL,
  section_id TEXT NOT NULL,
  course_id  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (term, section_id)
) STRICT;

CREATE INDEX IF NOT EXISTS sections_course ON sections (term, course_id);

CREATE TABLE IF NOT EXISTS courses (
  term       TEXT NOT NULL,
  course_id  TEXT NOT NULL,
  payload    TEXT NOT NULL,
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

  /** Everything cached for a term, optionally narrowed to certain courses. */
  read(term: string, courseIds?: string[]): TermCatalog {
    const rows = courseIds?.length
      ? this.#db
          .query<Row, [string, string]>(
            `SELECT payload, fetched_at FROM sections
             WHERE term = ? AND course_id IN (SELECT value FROM json_each(?))`,
          )
          .all(term, JSON.stringify(courseIds))
      : this.#db
          .query<Row, [string]>(`SELECT payload, fetched_at FROM sections WHERE term = ?`)
          .all(term);

    const catalog: TermCatalog = {
      term,
      fetchedAt: new Date(0).toISOString(),
      sections: [],
      courses: [],
    };
    for (const row of rows) {
      if (row.fetched_at > catalog.fetchedAt) catalog.fetchedAt = row.fetched_at;
      catalog.sections.push(JSON.parse(row.payload) as ListingSection);
    }

    // Requisites belong to the course, so a narrowed read still needs them
    // for every course it returned a section for.
    const wanted = courseIds?.length
      ? courseIds
      : [...new Set(catalog.sections.map((s) => s.CourseId))];
    catalog.courses = this.readCourses(term, wanted);
    return catalog;
  }

  readCourses(term: string, courseIds?: string[]): CatalogCourseRecord[] {
    const rows = courseIds?.length
      ? this.#db
          .query<{ payload: string }, [string, string]>(
            `SELECT payload FROM courses
             WHERE term = ? AND course_id IN (SELECT value FROM json_each(?))`,
          )
          .all(term, JSON.stringify(courseIds))
      : this.#db
          .query<{ payload: string }, [string]>(`SELECT payload FROM courses WHERE term = ?`)
          .all(term);
    return rows.map((r) => JSON.parse(r.payload) as CatalogCourseRecord);
  }

  /**
   * Replaces a term wholesale. A crawl sees every section that exists, so a
   * section absent from it has been cancelled and should not linger.
   */
  replace(catalog: TermCatalog): number {
    const insert = this.#db.query(
      `INSERT INTO sections (term, section_id, course_id, payload, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(term, section_id) DO UPDATE SET
         payload = excluded.payload, fetched_at = excluded.fetched_at`,
    );
    const clear = this.#db.query(`DELETE FROM sections WHERE term = ? AND fetched_at < ?`);

    const insertCourse = this.#db.query(
      `INSERT INTO courses (term, course_id, payload, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(term, course_id) DO UPDATE SET
         payload = excluded.payload, fetched_at = excluded.fetched_at`,
    );
    const clearCourses = this.#db.query(`DELETE FROM courses WHERE term = ? AND fetched_at < ?`);

    const run = this.#db.transaction(() => {
      for (const s of catalog.sections) {
        insert.run(catalog.term, s.Id, s.CourseId, JSON.stringify(s), catalog.fetchedAt);
      }
      clear.run(catalog.term, catalog.fetchedAt);

      // Only replace courses when the crawl actually collected them, so a
      // sections-only refresh does not wipe the requisite data.
      if (catalog.courses?.length) {
        for (const c of catalog.courses) {
          insertCourse.run(catalog.term, c.Id, JSON.stringify(c), catalog.fetchedAt);
        }
        clearCourses.run(catalog.term, catalog.fetchedAt);
      }
      return catalog.sections.length;
    });
    return run();
  }

  stats(): TermStats[] {
    return this.#db
      .query<TermStats, []>(
        `SELECT term,
                COUNT(*) AS sections,
                COUNT(DISTINCT course_id) AS courses,
                MAX(fetched_at) AS fetchedAt
         FROM sections GROUP BY term ORDER BY term`,
      )
      .all();
  }

  close() {
    this.#db.close();
  }
}

export interface TermStats {
  term: string;
  sections: number;
  courses: number;
  fetchedAt: string;
}

interface Row {
  payload: string;
  fetched_at: string;
}
