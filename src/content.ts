/**
 * Runs on selfservice.cedarville.edu and does nothing but fetch.
 *
 * Every request rides the student's existing session, so no credential is
 * collected, stored or transmitted. Interpretation happens in the app; this
 * side stays small enough to read in one sitting, which is the point of
 * asking anyone to install it.
 */

import { SelfService, UnauthorizedError } from "./client";
import { normalize, programFor, unservedCredentials } from "./requirements";
import type { Change, PlannedCourse } from "./sync";
import type {
  CatalogVocabulary,
  DegreePlanDto,
  DegreePlanResponse,
  EvaluationResponse,
  ProgramSummary,
} from "./types";

const api = new SelfService();

export interface Capture {
  capturedAt: string;
  studentId: string;
  enrolled: { code: string; title: string }[];
  /**
   * Majors and minors the registrar names that no active program code matches,
   * so nothing evaluated them. Always present, empty when there are none: a
   * capture missing the field came from an older build of the extension, which
   * is worth being able to tell apart from a capture that found nothing.
   */
  unmatched: string[];
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

  // A second major is recorded against the first one's enrolment and never
  // evaluated alongside it, so it has to be asked for by name. What comes back
  // is a what-if by mechanism only; the registrar has the student in it, so it
  // is reported as enrolled.
  const also: { code: string; title: string }[] = [];
  const unmatched: string[] = [];
  const unserved = new Map(
    Object.values(evaluations)
      .map(normalize)
      .flatMap((tree) => unservedCredentials(tree).map((name) => [name, tree] as const)),
  );
  if (unserved.size) {
    const catalog = await api.activePrograms();
    for (const [name, tree] of unserved) {
      const program = programFor(name, catalog, tree);
      if (!program) {
        unmatched.push(name);
        continue;
      }
      if (evaluations[program.Code]) continue;
      evaluations[program.Code] = await api.programEvaluation(id, program.Code, true);
      also.push({ code: program.Code, title: program.Title });
    }
  }

  for (const code of whatIf) {
    if (!evaluations[code]) {
      evaluations[code] = await api.programEvaluation(id, code, true);
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    studentId: id,
    enrolled: [...plan.StudentPrograms.map((p) => ({ code: p.Code, title: p.Title })), ...also],
    unmatched,
    evaluations,
  };
}

/** Colleague's own plan, as the diff wants to see it. */
export interface ColleaguePlan {
  studentId: string;
  planned: PlannedCourse[];
  /** Terms already on the plan. */
  terms: string[];
  /** Terms it could be extended with, which is where the summers are. */
  addable: string[];
  /** A protected plan is an advisor's, and this refuses to touch one. */
  locked: boolean;
}

const codesOf = (terms: { Code: string }[] | string[] | undefined): string[] =>
  (terms ?? []).map((t) => (typeof t === "string" ? t : t.Code));

function readPlan(response: DegreePlanResponse, studentId: string): ColleaguePlan {
  const plan = response.DegreePlan;
  const dto = plan.DegreePlanDto;
  return {
    studentId,
    planned: (dto.Terms ?? []).flatMap((term) =>
      (term.PlannedCourses ?? []).map((c) => ({
        courseId: c.CourseId,
        termId: c.TermId,
        credits: c.Credits,
        sectionId: c.SectionId,
        ...(c.IsProtected ? { isProtected: true } : {}),
      })),
    ),
    terms: (plan.Terms ?? []).map((t) => t.Code),
    addable: codesOf(plan.UnplannedTerms),
    locked: Boolean(plan.IsPlanProtected),
  };
}

/**
 * Runs the changes the app decided on, in order, against a plan fetched here.
 *
 * The DTO is never taken from the app: Colleague versions the plan and
 * refuses a stale copy, so the freshest one is the one this just fetched and
 * then the one each call hands back. Stops at the first failure and says how
 * far it got, because a half-applied plan the student is told about is a
 * great deal better than one they are not.
 */
async function applyPlan(changes: Change[]): Promise<Applied> {
  const id = await studentId();
  let response = await api.currentDegreePlan(id);
  if (response.DegreePlan.IsPlanProtected) {
    throw new Error("your degree plan is protected; an advisor has to unlock it");
  }

  let dto: DegreePlanDto = response.DegreePlan.DegreePlanDto;
  const done: Change[] = [];

  for (const change of changes) {
    try {
      switch (change.kind) {
        case "term":
          response = await api.addTermToPlan(change.termId, dto);
          break;
        case "add":
          response = await api.addCourseToPlan(change.courseId, change.termId, change.credits, dto);
          break;
        case "move":
          response = await api.moveCourseOnPlan(change.courseId, change.from, change.to, dto);
          break;
        case "remove":
          response = await api.removeCourseFromPlan(
            change.courseId,
            change.termId,
            change.sectionId,
            dto,
          );
          break;
      }
      dto = response.DegreePlan.DegreePlanDto;
      done.push(change);
    } catch (err) {
      return {
        applied: done,
        stopped: { change, why: err instanceof Error ? err.message : String(err) },
      };
    }
  }
  return { applied: done };
}

export interface Applied {
  applied: Change[];
  /** The change that failed, and why. Everything after it went untried. */
  stopped?: { change: Change; why: string };
}

export type Request =
  | { type: "ping" }
  | { type: "programs" }
  | { type: "terms" }
  | { type: "capture"; whatIf?: string[] }
  /** Colleague's degree plan, read only, for working out what would change. */
  | { type: "colleaguePlan" }
  /**
   * The one request in this file that writes to the registrar's system. The
   * app decides what the changes are; this only carries them out.
   */
  | { type: "applyPlan"; changes: Change[] }
  /**
   * What the student chose, on its way to their own machine. Never reaches
   * this file: the background answers it without troubling Self-Service,
   * which has no opinion about anybody's pins.
   */
  | { type: "picks"; picks: unknown };

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string; signedOut?: boolean };

export interface ReplyMap {
  ping: true;
  picks: true;
  programs: ProgramSummary[];
  terms: { code: string; description: string }[];
  capture: Capture;
  colleaguePlan: ColleaguePlan;
  applyPlan: Applied;
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
        case "colleaguePlan": {
          const id = await studentId();
          return { ok: true, data: readPlan(await api.currentDegreePlan(id), id) };
        }
        case "applyPlan":
          return { ok: true, data: await applyPlan(msg.changes) };
        default:
          // "picks" never gets this far; the background answers it.
          return { ok: false, error: `this half does not answer ${(msg as Request).type}` };
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
