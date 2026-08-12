/**
 * Runs on selfservice.cedarville.edu and does nothing but fetch.
 *
 * Every request rides the student's existing session, so no credential is
 * collected, stored or transmitted. Interpretation happens in the app; this
 * side stays small enough to read in one sitting, which is the point of
 * asking anyone to install it.
 */

import { SelfService, UnauthorizedError } from "./client";
import type {
  CatalogVocabulary,
  EvaluationResponse,
  ProgramSummary,
  SectionsResponse,
} from "./types";

const api = new SelfService();

export interface Capture {
  capturedAt: string;
  studentId: string;
  enrolled: { code: string; title: string }[];
  /** Raw evaluations, keyed by program code. The app normalizes them. */
  evaluations: Record<string, EvaluationResponse>;
}

/** The student id is not exposed directly; the degree plan carries it. */
async function studentId(): Promise<string> {
  const fromDom = document.querySelector<HTMLElement>("[data-person-id]")?.dataset.personId;
  if (fromDom) return fromDom;

  const plan = await api.currentDegreePlan("");
  const id = plan.DegreePlan?.PersonId ?? plan.StudentPrograms?.[0]?.StudentId;
  if (!id) throw new Error("could not determine student id");
  return id;
}

/**
 * @param whatIf program codes the student is not enrolled in, evaluated
 *               against their real transcript.
 */
async function capture(whatIf: string[] = []): Promise<Capture> {
  const id = await studentId();
  const plan = await api.currentDegreePlan(id);
  const enrolled = plan.StudentPrograms.map((p) => p.Code);

  const evaluations: Record<string, EvaluationResponse> = {};
  for (const code of enrolled) {
    evaluations[code] = await api.programEvaluation(id, code, false);
  }
  for (const code of whatIf) {
    if (!enrolled.includes(code)) {
      evaluations[code] = await api.programEvaluation(id, code, true);
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    studentId: id,
    enrolled: plan.StudentPrograms.map((p) => ({ code: p.Code, title: p.Title })),
    evaluations,
  };
}

/**
 * Sections for a set of courses, in one term.
 *
 * Crawling the whole catalog would be hundreds of requests against the
 * school's SIS for data we mostly do not want. The caller passes the courses
 * that could actually satisfy an open requirement, which is a couple of
 * hundred at most and usually far fewer.
 */
async function fetchSections(courseIds: string[], term: string): Promise<SectionsCapture> {
  const wanted = [...new Set(courseIds)];
  const sections: Record<string, SectionsResponse> = {};
  const missing: string[] = [];

  // One search resolves every course's section ids; then one call per course.
  const search = await api.searchCourses({
    courseIds: wanted,
    terms: [term],
    quantityPerPage: Math.max(wanted.length, 1),
  });

  for (const course of search.Courses ?? []) {
    const ids = course.MatchingSectionIds ?? [];
    if (ids.length === 0) {
      missing.push(course.Id);
      continue;
    }
    sections[course.Id] = await api.sections(course.Id, ids);
    // Deliberately unhurried: this is someone's registrar, not a load test.
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  return {
    capturedAt: new Date().toISOString(),
    term,
    requested: wanted.length,
    /** Courses with no section offered in this term. */
    notOffered: missing,
    sections,
  };
}

export interface SectionsCapture {
  capturedAt: string;
  term: string;
  requested: number;
  notOffered: string[];
  sections: Record<string, SectionsResponse>;
}

export type Request =
  | { type: "ping" }
  | { type: "programs" }
  | { type: "terms" }
  | { type: "capture"; whatIf?: string[] }
  | { type: "sections"; courseIds: string[]; term: string };

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string; signedOut?: boolean };

export interface ReplyMap {
  ping: true;
  programs: ProgramSummary[];
  terms: { code: string; description: string }[];
  capture: Capture;
  sections: SectionsCapture;
}

chrome.runtime.onMessage.addListener((msg: Request, _sender, reply) => {
  const run = async (): Promise<Reply<unknown>> => {
    try {
      switch (msg.type) {
        case "ping":
          await api.token();
          return { ok: true, data: true };
        case "programs":
          return { ok: true, data: await api.activePrograms() };
        case "terms": {
          const vocabulary: CatalogVocabulary = await api.catalogVocabulary();
          // Tuples arrive as Item1 = code, Item2 = description.
          const terms = (vocabulary.Terms ?? []).map((t) => ({
            code: t.Item1,
            description: t.Item2,
          }));
          return { ok: true, data: terms };
        }
        case "capture":
          return { ok: true, data: await capture(msg.whatIf) };
        case "sections":
          return { ok: true, data: await fetchSections(msg.courseIds, msg.term) };
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        signedOut: err instanceof UnauthorizedError,
      };
    }
  };

  run().then(reply);
  return true; // keep the channel open for the async reply
});
