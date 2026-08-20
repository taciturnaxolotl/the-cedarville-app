/* What every view is handed. Grows as the app learns to fetch more. */

import type { TermCatalog } from "../catalog";
import type { Capture } from "../content";
import type { ProgramTree } from "../requirements";

export interface Ctx {
  /**
   * Every program evaluated, enrolled or hypothetical. A what-if evaluation
   * comes back in exactly the same shape as a real one, which is what makes
   * "what if I added this minor" answerable — and also why the trees alone
   * cannot say which programs the student is actually in.
   */
  trees: ProgramTree[];
  /** Program codes the registrar has the student enrolled in. */
  enrolled?: string[];
  /** Credentials the registrar names that no program code matched. */
  unmatched?: string[];
  sections?: TermCatalog;
  /**
   * Every course in the catalog, offered this term or not. Prerequisites
   * routinely name courses nobody is teaching, and a graph built only from
   * one term's offerings loses about a third of its depth.
   */
  allCourses?: TermCatalog["courses"];
  /**
   * Hands a fresh capture back to the shell, which owns the trees.
   *
   * The build view is the one place a view changes what every other view is
   * looking at: picking a second major re-evaluates the whole degree. Rather
   * than let it write to the shell's store directly, it asks.
   */
  adopt?: (snapshot: Capture) => void;
}
