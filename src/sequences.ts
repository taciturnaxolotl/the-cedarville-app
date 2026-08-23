/**
 * Courses that run back to back.
 *
 * A capstone is one course wearing two course codes. Secure Software
 * Engineering I is taught in the autumn and II in the spring after it, with
 * the same team carrying the same project across the join — nobody does the
 * first half and picks the second one up eighteen months later. The same is
 * true of Making of the Modern Mind and of the honours colloquium.
 *
 * Colleague states none of this. It knows CY-4820 needs CY-4810, which only
 * says "later", and a planner reading that literally will happily leave a year
 * in the middle: a four-credit spring course that does not fit this spring
 * fits the next one just as well, arithmetically, and is nonsense in practice.
 *
 * So the pairs are read out of the catalog three ways, in the order they are
 * worth trusting.
 */

import type { CatalogCourseRecord } from "./catalog";
import { seasonsOffered } from "./catalog";

/** Follower to leader: `CY-4820` runs the term after `CY-4810`. */
export type Sequences = Map<string, string>;

const CONTINUATION = /\bcontinuation of\s+([A-Z]{2,5}-\d{3,4}[A-Z]?)/i;
/** "Secure Software Engr I" and its second half. Roman numerals only. */
const NUMBERED = /^(.*?)\s+(I{1,3})$/;

const codeOf = (record: { SubjectCode: string; Number: string }) =>
  `${record.SubjectCode}-${record.Number}`;

/**
 * The part of a title the two halves of a sequence share.
 *
 * Cedarville writes the pair as one name and a distinguishing tail: "Making
 * Mod Mind: Cl Antiquity" and "Making Mod Mind: Ren/Reform". Everything up to
 * the colon is the course; everything after it is which half.
 */
const stemOf = (title: string | undefined) => (title ?? "").split(":")[0]?.trim().toLowerCase();

/** Autumn is followed by spring, spring by autumn. A summer follows nothing. */
const followsOn = (leader: string[], follower: string[]) =>
  leader.length === 1 &&
  follower.length === 1 &&
  ((leader[0] === "fall" && follower[0] === "spring") ||
    (leader[0] === "spring" && follower[0] === "fall"));

export function sequencesFrom(records: readonly CatalogCourseRecord[]): Sequences {
  const pairs: Sequences = new Map();
  const byCode = new Map(records.map((r) => [codeOf(r), r]));

  /** Its own description names the course it continues: the plainest evidence. */
  for (const record of records) {
    const said = CONTINUATION.exec(record.Description ?? "");
    const leader = said?.[1];
    if (leader && byCode.has(leader) && leader !== codeOf(record)) {
      pairs.set(codeOf(record), leader);
    }
  }

  /**
   * A title ending in II, over a course of the same name ending in I. The
   * subject has to match: "Honors Sr Colloq I" and "Honors Sr Colloq II" are a
   * pair, and two unrelated departments' "Seminar I" are not.
   */
  const numbered = new Map<string, string>();
  for (const record of records) {
    const parts = NUMBERED.exec(record.Title ?? "");
    if (!parts) continue;
    numbered.set(`${record.SubjectCode}|${parts[1]}|${parts[2]}`, codeOf(record));
  }
  for (const [key, follower] of numbered) {
    const [subject, stem, numeral] = key.split("|");
    if (numeral === "I") continue;
    const leader = numbered.get(`${subject}|${stem}|${"I".repeat((numeral ?? "").length - 1)}`);
    if (leader && !pairs.has(follower)) pairs.set(follower, leader);
  }

  /**
   * And the pair that says it only by how it is taught. Making of the Modern
   * Mind is this: HON-1010 in the autumn, HON-1020 in the spring, the spring
   * one waiting on the autumn one, and nothing anywhere calling it a sequence.
   *
   * Four things have to line up, and every one of them is doing work. One
   * prerequisite and one season each, fitting together the way a sequence does
   * — a course taught every term loses nothing by waiting, so it is not this.
   * The same subject and a number within twenty of the leader's. And a shared
   * title stem, which is what separates "Making Mod Mind: Cl Antiquity" and
   * "Making Mod Mind: Ren/Reform" from General Botany and General Ecology,
   * where one merely waits on the other.
   */
  for (const record of records) {
    const follower = codeOf(record);
    if (pairs.has(follower)) continue;

    const required = (record.CourseRequisites ?? []).filter((r) => r.IsRequired !== false);
    const named = [
      ...new Set(
        required.flatMap((r) => r.DisplayText?.match(/\b[A-Z]{2,5}-\d{3,4}[A-Z]?\b/g) ?? []),
      ),
    ];
    if (named.length !== 1) continue;

    const leader = named[0];
    const before = leader ? byCode.get(leader) : undefined;
    if (!leader || !before) continue;
    if (before.SubjectCode !== record.SubjectCode) continue;
    if (Math.abs(Number(record.Number) - Number(before.Number)) > 20) continue;
    if (stemOf(before.Title) !== stemOf(record.Title)) continue;
    if (followsOn(seasonsOffered(before), seasonsOffered(record))) pairs.set(follower, leader);
  }

  return pairs;
}
