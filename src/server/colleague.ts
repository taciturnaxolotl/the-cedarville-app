/**
 * Reading the public course catalog, with no student involved.
 *
 * Self-Service exposes course search anonymously at /Student/Courses/*. The
 * authenticated app calls /Student/Student/Courses/*, and only that path is
 * gated; the guest one is what the signed-out search page itself uses. So the
 * whole catalog can be fetched here, server-side, and no student's session is
 * ever spent on data that is identical for all of them.
 *
 * Nothing personal is reachable from these routes, which is exactly why this
 * file is allowed to exist on a server.
 */

const ORIGIN = "https://selfservice.cedarville.edu";
const TOKEN_PAGE = "/Student/Courses/Search";
const TOKEN_RE = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/;

/** Ellucian ships this exact malformed content type. Mirroring it. */
const JSON_CT = "application/json, charset=UTF-8";

export interface SearchCriteria {
  terms?: string[];
  subjects?: string[];
  courseIds?: string[];
  /** Degree-audit coordinates: asks Colleague to evaluate that group's rule. */
  requirement?: string;
  subrequirement?: string;
  group?: string;
  keyword?: string;
  pageNumber?: number;
  quantityPerPage?: number;
  searchResultsView?: "SectionListing" | "CatalogListing";
}

export interface SearchPage {
  Sections?: unknown[];
  Courses?: unknown[];
  CourseFullModels?: unknown[];
  TotalItems: number;
  TotalPages: number;
  CurrentPageIndex: number;
}

export interface Vocabulary {
  Subjects: { Code: string; Description: string; ShowInCourseSearch: boolean }[];
  Terms: { Item1: string; Item2: string }[];
}

/**
 * Holds the antiforgery token and the cookie it is bound to. Bun's fetch has
 * no cookie jar, so the pairing is kept by hand: a token is only valid
 * alongside the .ColleagueSelfServiceAntiforgery cookie minted with it.
 */
export class GuestColleague {
  #cookies = "";
  #token = "";

  async #handshake(): Promise<void> {
    const res = await fetch(ORIGIN + TOKEN_PAGE, {
      headers: { "user-agent": USER_AGENT, accept: "text/html" },
    });
    const html = await res.text();

    const token = TOKEN_RE.exec(html)?.[1];
    if (!token) throw new Error("no antiforgery token on the Self-Service search page");

    this.#cookies = res.headers
      .getSetCookie()
      .map((c) => c.split(";", 1)[0])
      .join("; ");
    this.#token = token;
  }

  async #post<T>(path: string, body: unknown, retry = true): Promise<T> {
    if (!this.#token) await this.#handshake();

    const res = await fetch(ORIGIN + path, {
      method: "POST",
      headers: {
        "content-type": JSON_CT,
        accept: "application/json",
        "x-requested-with": "XMLHttpRequest",
        __RequestVerificationToken: this.#token,
        cookie: this.#cookies,
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      redirect: "follow",
    });

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      // Tokens expire. Re-handshake once, then give up rather than loop.
      if (retry && (text.includes("antiforgery") || res.url.includes("/Account/"))) {
        this.#token = "";
        return this.#post<T>(path, body, false);
      }
      throw new Error(`${path} returned non-JSON (${text.slice(0, 100)})`);
    }
  }

  async vocabulary(): Promise<Vocabulary> {
    if (!this.#token) await this.#handshake();
    const res = await fetch(ORIGIN + "/Student/Courses/GetCatalogAdvancedSearch", {
      headers: {
        accept: "application/json",
        "x-requested-with": "XMLHttpRequest",
        __RequestVerificationToken: this.#token,
        cookie: this.#cookies,
        "user-agent": USER_AGENT,
      },
    });
    return (await res.json()) as Vocabulary;
  }

  search(criteria: SearchCriteria): Promise<SearchPage> {
    return this.#post<SearchPage>("/Student/Courses/PostSearchCriteria", {
      pageNumber: 1,
      quantityPerPage: 100,
      searchResultsView: "SectionListing",
      ...criteria,
    });
  }

  /** Term codes as Colleague states them, e.g. "2026FA". */
  async terms(): Promise<{ code: string; description: string }[]> {
    const vocabulary = await this.vocabulary();
    return (vocabulary.Terms ?? []).map((t) => ({ code: t.Item1, description: t.Item2 }));
  }
}

const USER_AGENT = "the-cedarville-app (student course planner; github.com/taciturnaxolotl)";

/**
 * The courses that satisfy one requirement group, as Colleague itself decides.
 *
 * This is the escape hatch for everything the evaluation refuses to enumerate.
 * A group whose eligible courses live in an opaque rule (`DABIOL25`) or behind
 * a department filter still has an identity — requirement, subrequirement and
 * group id — and the course search accepts exactly that triple. The server
 * evaluates the rule and hands back the list, which is the same answer the
 * "Search for courses" button in the degree audit produces.
 *
 * No session is needed. The triple names a place in the catalog, not a
 * student, so one lookup serves everybody.
 */
export async function resolveGroup(
  ids: { requirement: string; subrequirement: string; group: string },
  client = new GuestColleague(),
): Promise<string[]> {
  const names = new Set<string>();
  let page = 1;
  let pages = 1;

  while (page <= pages) {
    const result = await client.search({
      requirement: ids.requirement,
      subrequirement: ids.subrequirement,
      group: ids.group,
      pageNumber: page,
      searchResultsView: "CatalogListing",
    });
    pages = Math.max(result.TotalPages ?? 1, 1);

    for (const raw of result.Courses ?? []) {
      const course = raw as { SubjectCode?: string; Number?: string };
      if (course.SubjectCode && course.Number) names.add(`${course.SubjectCode}-${course.Number}`);
    }
    page++;
  }
  return [...names].sort();
}
