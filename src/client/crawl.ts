/**
 * Fetching a term's sections, politely and visibly.
 *
 * The loop lives here rather than in the extension because everything that
 * makes it bearable is a user-experience decision: how fast to go, what to
 * skip because the shared cache already has it, how to report progress, and
 * how to stop halfway. The extension just fetches what it is told to.
 */

import { emptyCatalog, known, mergeCatalogs, type TermCatalog } from "../catalog";
import { sectionIds, sections } from "./bridge";

export interface Progress {
  done: number;
  total: number;
  /** The course being fetched, for something concrete to read. */
  current: string;
  /** Answered from the shared cache instead of Self-Service. */
  cached: number;
}

export interface CrawlOptions {
  courseIds: string[];
  term: string;
  /** Already-known sections, typically from the server cache. */
  have?: TermCatalog;
  onProgress?: (progress: Progress) => void;
  signal?: AbortSignal;
  /** Gap between requests. This is a registrar, not a load test. */
  delayMs?: number;
}

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function crawl(options: CrawlOptions): Promise<TermCatalog> {
  const { courseIds, term, onProgress, signal, delayMs = 120 } = options;
  const have = options.have ?? emptyCatalog(term);
  const cachedIds = known(have);

  const fresh = emptyCatalog(term);
  // One search covers every course, so it is cheap even for ones we cache.
  const catalogue = await sectionIds(courseIds, term);

  const todo = catalogue.filter((c) => !cachedIds.has(c.courseId));
  const cached = catalogue.length - todo.length;
  let done = 0;

  onProgress?.({ done, total: todo.length, current: "", cached });

  for (const course of todo) {
    if (signal?.aborted) throw new Cancelled();
    onProgress?.({ done, total: todo.length, current: course.courseName, cached });

    if (course.sectionIds.length === 0) {
      fresh.notOffered.push(course.courseId);
    } else {
      fresh.sections[course.courseId] = await sections(course.courseId, course.sectionIds);
      // Only sleep after a real request; skipping costs nobody anything.
      if (delayMs > 0) await sleep(delayMs);
    }

    done++;
    onProgress?.({ done, total: todo.length, current: course.courseName, cached });
  }

  return mergeCatalogs(have, fresh);
}
