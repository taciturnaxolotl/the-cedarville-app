import { describe, expect, test } from "bun:test";
import { extractCookie } from "./session";

const CURL = `curl 'https://selfservice.cedarville.edu/Student/Planning/DegreePlans/Current' \\
  -H 'accept: application/json' \\
  -H 'cookie: _ga=GA1.1.123; .ASPXAUTH=ABC123; SERVERID=s1; studentselfservice_live_sfid=xyz; _fbp=fb.1; .ColleagueSelfServiceAntiforgery=CfDJ8tok' \\
  -H 'x-requested-with: XMLHttpRequest'`;

describe("extracting a session", () => {
  test("reads the cookie header out of a copied cURL", () => {
    expect(extractCookie(CURL)).toBe(
      ".ASPXAUTH=ABC123; SERVERID=s1; studentselfservice_live_sfid=xyz; .ColleagueSelfServiceAntiforgery=CfDJ8tok",
    );
  });

  // A browser cookie jar carries trackers and unrelated sites. Writing the
  // whole thing to disk would store far more than this needs.
  test("keeps only the cookies Self-Service authenticates with", () => {
    const kept = extractCookie(CURL) ?? "";
    expect(kept).not.toContain("_ga");
    expect(kept).not.toContain("_fbp");
  });

  test("accepts a bare header line or a bare cookie string", () => {
    expect(extractCookie("cookie: .ASPXAUTH=Q; junk=1")).toBe(".ASPXAUTH=Q");
    expect(extractCookie(".ASPXAUTH=Z; _ga=drop")).toBe(".ASPXAUTH=Z");
  });

  /**
   * Regression: a real session was saved with eight cookies and still failed
   * to authenticate. ASP.NET chunks an oversized cookie into a base plus
   * numbered parts, and an exact-match filter kept "..._0" while dropping the
   * base "studentselfservice_live" it belongs to.
   */
  test("keeps chunked cookies and the base they belong to", () => {
    const kept =
      extractCookie(
        "cookie: studentselfservice_live=chunks:2; studentselfservice_live_0=aaa; " +
          "studentselfservice_live_1=bbb; .ASPXAUTHC1=ccc; .ASPXAUTH=ddd; _ga=drop",
      ) ?? "";
    expect(kept).toContain("studentselfservice_live=chunks:2");
    expect(kept).toContain("studentselfservice_live_0=aaa");
    expect(kept).toContain("studentselfservice_live_1=bbb");
    expect(kept).toContain(".ASPXAUTHC1=ccc");
    expect(kept).toContain(".ASPXAUTH=ddd");
    expect(kept).not.toContain("_ga");
  });

  test("returns null rather than an empty session", () => {
    expect(extractCookie("no cookies here")).toBeNull();
    expect(extractCookie("")).toBeNull();
    expect(extractCookie("cookie: _ga=only-trackers")).toBeNull();
  });
});
