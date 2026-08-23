/**
 * Client for the internal Colleague Self-Service endpoints.
 *
 * Runs inside a content script on selfservice.cedarville.edu so that every
 * request carries the student's own session. No credential is ever handled
 * here; the browser already has one.
 */

import type {
  CatalogVocabulary,
  DegreePlanDto,
  DegreePlanResponse,
  DegreePlanView,
  EvaluationResponse,
  ProgramSummary,
  SearchCriteria,
  SearchResponse,
  SectionsResponse,
} from "./types";

export const ORIGIN = "https://selfservice.cedarville.edu";

/** Ellucian ships this exact malformed content type. Mirroring it. */
const JSON_CT = "application/json, charset=UTF-8";

/** Any Self-Service page renders the hidden antiforgery input. */
const TOKEN_PAGE = "/Student/Courses/Search";
const TOKEN_RE = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/;

export class UnauthorizedError extends Error {
  constructor(readonly endpoint: string) {
    super(`not signed in to Self-Service (${endpoint})`);
    this.name = "UnauthorizedError";
  }
}

export class SelfService {
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
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // A stale token yields the antiforgery complaint as plain text.
      if (text.includes("antiforgery")) {
        this.#token = null;
        throw new Error(`antiforgery token rejected on ${path}; retry`);
      }
      throw new Error(`${path} returned non-JSON (${text.slice(0, 80)})`);
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
  activePrograms(): Promise<ProgramSummary[]> {
    return this.get("/Student/Planning/Programs/GetActivePrograms");
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

  searchCourses(criteria: Partial<SearchCriteria>): Promise<SearchResponse> {
    return this.post("/Student/Student/Courses/PostSearchCriteria", {
      pageNumber: 1,
      quantityPerPage: 100,
      searchResultsView: "CatalogListing",
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
