/* What every view is handed. Grows as the app learns to fetch more. */

import type { TermCatalog } from "../catalog";
import type { ProgramTree } from "../requirements";

export interface Ctx {
  trees: ProgramTree[];
  sections?: TermCatalog;
  /**
   * Every course in the catalog, offered this term or not. Prerequisites
   * routinely name courses nobody is teaching, and a graph built only from
   * one term's offerings loses about a third of its depth.
   */
  allCourses?: TermCatalog["courses"];
}
