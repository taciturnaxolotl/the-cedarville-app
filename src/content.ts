/**
 * Runs on selfservice.cedarville.edu and does nothing but fetch.
 *
 * Every request rides the student's existing session, so no credential is
 * collected, stored or transmitted. Interpretation happens in the app; this
 * side stays small enough to read in one sitting, which is the point of
 * asking anyone to install it.
 */

import { SelfService, UnauthorizedError } from "./client";
import type { EvaluationResponse, ProgramSummary } from "./types";

const api = new SelfService();

export interface Capture {
  capturedAt: string;
  studentId: string;
  enrolled: { code: string; title: string }[];
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
  for (const code of whatIf) {
    if (!enrolled.includes(code)) {
      evaluations[code] = await api.programEvaluation(id, code, true);
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    studentId: id,
    enrolled: plan.StudentPrograms.map((p) => ({ code: p.Code, title: p.Title })),
    evaluations,
  };
}

export type Request =
  | { type: "ping" }
  | { type: "programs" }
  | { type: "capture"; whatIf?: string[] };

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string; signedOut?: boolean };

export interface ReplyMap {
  ping: true;
  programs: ProgramSummary[];
  capture: Capture;
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
        case "capture":
          return { ok: true, data: await capture(msg.whatIf) };
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
