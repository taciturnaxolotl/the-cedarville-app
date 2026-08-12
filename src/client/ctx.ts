/* What every view is handed. Grows as the app learns to fetch more. */

import type { TermCatalog } from "../catalog";
import type { ProgramTree } from "../requirements";

export interface Ctx {
  trees: ProgramTree[];
  sections?: TermCatalog;
}
