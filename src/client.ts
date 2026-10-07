/**
 * Client for the internal Colleague Self-Service endpoints.
 *
 * Runs inside a content script on selfservice.cedarville.edu so that every
 * request carries the student's own session. No credential is ever handled
 * here; the browser already has one.
 */

import type { SearchCriteria, Searcher, SearchPage } from "./crawl";
import type {
  CatalogVocabulary,
  DegreePlanDto,
  DegreePlanResponse,
  DegreePlanView,
  EvaluationResponse,
  ProgramSummary,
  SectionsResponse,
} from "./types";

export const ORIGIN = "https://selfservice.cedarville.edu";

/** Ellucian ships this exact malformed content type. Mirroring it. */
const JSON_CT = "application/json, charset=UTF-8";

/** Any Self-Service page renders the hidden antiforgery input. */
const TOKEN_PAGE = "/Student/Courses/Search";
const TOKEN_RE = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/;

/**
 * What a status code means to somebody who is not reading the network tab.
 *
 * Colleague answers a refused write with a plain 500 and no body, which as
 * "POST /Student/Planning/DegreePlans/AddCourse -> 500" tells a student
 * nothing they can act on.
 */
function plainly(status: number): string {
  if (status === 403) return "Self-Service refused that; your session may have expired";
  if (status === 404) return "Self-Service has no such record any more";
  if (status === 409) return "your plan changed somewhere else; read it again and retry";
  if (status >= 500) return `Self-Service could not do that (error ${status})`;
  return `Self-Service refused that (error ${status})`;
}

export class UnauthorizedError extends Error {
  constructor(readonly endpoint: string) {
    super(`not signed in to Self-Service (${endpoint})`);
    this.name = "UnauthorizedError";
  }
}

/** Something with a program code on it, which is all this has to recognise. */
const looksLikeProgram = (value: unknown) =>
  Boolean(value) &&
  typeof value === "object" &&
  typeof (value as { Code?: unknown }).Code === "string";

/**
 * Colleague's program list, however it chose to wrap it today.
 *
 * `GetActivePrograms` answers with a bare array on the build this was written
 * against and with something else on at least one build since: the planner
 * reported "list.filter is not a function", which is a TypeError standing
 * where a sentence should be.
 *
 * Rather than guess at the wrapper, take any object carrying an array of
 * things with program codes on them — the same tolerance `#written` already
 * applies to a degree plan that arrives bare or inside a property. And when it
 * is none of those, say what did arrive: a reader with the keys in front of
 * them can fix this in a minute, where a TypeError tells them nothing.
 */
export function programsIn(answer: unknown): ProgramSummary[] {
  if (Array.isArray(answer)) return answer as ProgramSummary[];

  if (answer && typeof answer === "object") {
    const arrays = Object.values(answer).filter(Array.isArray) as unknown[][];
    const programs = arrays.find((entries) => looksLikeProgram(entries[0]));
    if (programs) return programs as ProgramSummary[];
    // A school with no active programs is not a thing, but an empty answer is
    // still an answer when there is only one array to be wrong about.
    if (arrays.length === 1 && arrays[0]!.length === 0) return [];

    const keys = Object.keys(answer).join(", ") || "no keys at all";
    throw new Error(
      `Self-Service answered the program list with an object rather than a list (${keys})`,
    );
  }

  throw new Error(`Self-Service answered the program list with ${typeof answer}, not a list`);
}

export class SelfService implements Searcher {
  #token: string | null = null;

  /**
   * Antiforgery tokens are bound to the .ColleagueSelfServiceAntiforgery
   * cookie, so the fetch that mints one must share this browsing context.
   */
  async token(): Promise<string> {
    if (this.#token) return this.#token;

    const fromDom = document.querySelector<HTMLInputElement>(
      'input[name="__RequestVerificationToken"]',
    )?.value;
    if (fromDom) return (this.#token = fromDom);

    const html = await fetch(ORIGIN + TOKEN_PAGE, { credentials: "include" }).then((r) => r.text());
    const match = TOKEN_RE.exec(html);
    if (!match?.[1]) throw new Error("no antiforgery token in Self-Service page");
    return (this.#token = match[1]);
  }

  async #request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      __RequestVerificationToken: await this.token(),
    };
    if (body !== undefined) headers["Content-Type"] = JSON_CT;

    const res = await fetch(ORIGIN + path, {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // An expired session redirects to an HTML error page rather than 401ing.
    if (res.url.includes("/Account/Unauthorized") || res.url.includes("signin.cedarville.edu")) {
      throw new UnauthorizedError(path);
    }
    // These reach a student, sometimes mid-sync, so they say what happened
    // rather than which verb hit which path. The path is still worth carrying
    // for anyone reading a console, so it goes at the end where it can be
    // ignored.
    if (!res.ok) throw new Error(`${plainly(res.status)} (${path})`);

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // A stale token yields the antiforgery complaint as plain text.
      if (text.includes("antiforgery")) {
        this.#token = null;
        throw new Error("Self-Service rejected the request as stale; try again");
      }
      throw new Error(`Self-Service answered with a page rather than data (${path})`);
    }
  }

  /**
   * A write, unwrapped. Colleague answers a mutation with the plan itself and
   * `Current` with the plan inside a wrapper; this accepts either, so nothing
   * downstream has to know which endpoint it came from.
   */
  async #written(path: string, body: unknown): Promise<DegreePlanView> {
    const answer = await this.post<DegreePlanView & { DegreePlan?: DegreePlanView }>(path, body);
    return answer.DegreePlan ?? answer;
  }

  get<T>(path: string, query?: Record<string, string>): Promise<T> {
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    return this.#request<T>("GET", path + qs);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.#request<T>("POST", path, body);
  }

  // ---- endpoints -------------------------------------------------------

  /** Filter vocabulary: subject codes, term codes, locations, day codes. */
  catalogVocabulary(): Promise<CatalogVocabulary> {
    return this.get("/Student/Student/Courses/GetCatalogAdvancedSearch");
  }

  /** Every program the school offers, with the codes ProgramEvaluation wants. */
  async activePrograms(): Promise<ProgramSummary[]> {
    return programsIn(await this.get<unknown>("/Student/Planning/Programs/GetActivePrograms"));
  }

  /** Carries the signed-in student's id, which most other calls need. */
  currentDegreePlan(studentId: string): Promise<DegreePlanResponse> {
    return this.get("/Student/Planning/DegreePlans/Current", { studentId });
  }

  /**
   * The requirement tree. `whatIf` evaluates a program the student is not
   * enrolled in against their real transcript, which is what makes
   * dual-major planning possible.
   */
  programEvaluation(
    studentId: string,
    program: string,
    whatIf = false,
  ): Promise<EvaluationResponse> {
    return this.post("/Student/Planning/Programs/ProgramEvaluation", {
      program,
      isWhatIfEvaluation: whatIf,
      studentId,
    });
  }

  /**
   * Course search, on the student's own session.
   *
   * The authenticated twin of the guest endpoint the server used to crawl:
   * same body, same paging, one `/Student` more in the path. Cedarville put
   * the guest half behind SSO, so this is now the only way the catalog can be
   * read at all, which is why it satisfies the same `Searcher` shape the
   * crawl loop takes, and why that loop runs here unchanged.
   *
   * No default view. The crawl asks for the one it wants, and choosing on its
   * behalf is how a section crawl quietly comes back full of courses.
   */
  search(criteria: SearchCriteria): Promise<SearchPage> {
    return this.post("/Student/Student/Courses/PostSearchCriteria", {
      pageNumber: 1,
      quantityPerPage: 100,
      ...criteria,
    });
  }

  /** Meeting times, seat counts and instructors for a course's sections. */
  sections(courseId: string, sectionIds: string[]): Promise<SectionsResponse> {
    return this.post("/Student/Student/Courses/Sections", { courseId, sectionIds });
  }

  // ---- writing to the degree plan --------------------------------------
  //
  // Each of these hands back the updated plan, and hands it back bare: where
  // `Current` wraps the same object in a `DegreePlan` property, a write
  // returns it on its own. Reading the wrapper off a write threw on every
  // call, after the change had already been made — so the plan filled up
  // while the interface reported nothing written at all.
  //
  // The only endpoints in this file that change anything. Argument names are
  // Self-Service's own, read off the Plan & Schedule bundle rather than
  // guessed at, and each call carries the whole plan and returns the updated
  // copy: the DTO holds a Version and Colleague refuses a stale one. So these
  // run in sequence, each fed what the last one handed back.
  //
  // `RegisterSections` lives on the same controller and is deliberately
  // absent. Planning a course and registering for it are different promises.

  /** Puts a course in a term. `credits` is what a variable-credit course is taken for. */
  addCourseToPlan(
    courseId: string,
    termId: string,
    credits: number,
    degreePlan: DegreePlanDto,
  ): Promise<DegreePlanView> {
    return this.#written("/Student/Planning/DegreePlans/AddCourse", {
      courseId,
      termId,
      credits,
      degreePlan,
    });
  }

  /** Carries a planned course from one term to another. The drag, server-side. */
  moveCourseOnPlan(
    courseId: string,
    oldTerm: string,
    newTerm: string,
    degreePlan: DegreePlanDto,
  ): Promise<DegreePlanView> {
    return this.#written("/Student/Planning/DegreePlans/UpdateCourse", {
      courseId,
      oldTerm,
      newTerm,
      degreePlan,
    });
  }

  removeCourseFromPlan(
    courseId: string,
    termId: string,
    sectionId: string | null,
    degreePlan: DegreePlanDto,
  ): Promise<DegreePlanView> {
    return this.#written("/Student/Planning/DegreePlans/RemoveCourse", {
      removeCourseId: courseId,
      removeCourseTermId: termId,
      removeCourseSectionId: sectionId,
      degreePlan,
    });
  }

  /** Opens a term on the plan. Colleague will not hold a course in a term the plan has not got. */
  addTermToPlan(termId: string, degreePlan: DegreePlanDto): Promise<DegreePlanView> {
    return this.#written("/Student/Planning/DegreePlans/AddTerm", {
      addTermId: termId,
      degreePlan,
    });
  }
}
