/* What every view is handed. Grows as the app learns to fetch more. */

import type { SectionsCapture } from "../content";
import type { ProgramTree } from "../requirements";

export interface Ctx {
  trees: ProgramTree[];
  sections?: SectionsCapture;
}
