import type { ArmSpec } from "../arms.js";
import type { BootstrapCI } from "../metrics/bootstrap.js";

export type UsefulnessArm = "full" | "ablated" | "none";
export type RetrievalArm = Exclude<UsefulnessArm, "none">;

export interface MinedItem {
  question: string;
  facts: string[];
  evidence: string[];
}

export interface MinedQuestion extends MinedItem {
  id: string;
  project: string;
  sessionId: string;
  transcriptPath: string;
  // The question's session start (ISO). Only notes from sessions that started
  // strictly before it may be shown to the answerer.
  cutoff: string;
}

export type DropReason = "unparsed" | "fact-count" | "answer-in-question" | "bad-evidence";

export interface QuestionFile {
  createdAt: string;
  minerPromptVersion: string;
  model: string;
  transcriptsSeen: number;
  candidates: number;
  drops: Record<DropReason, number>;
  questions: MinedQuestion[];
}

export interface RetrievedHit {
  filePath: string;
  title: string;
  content: string;
  score: number;
  method: "embedding" | "tfidf";
  // null for topic / article / PDF notes: they carry no session_id.
  sessionId: string | null;
  startedAt: string | null;
}

export interface ArmRetrieval {
  questionId: string;
  method: "embedding" | "tfidf";
  degraded: boolean;
  hits: RetrievedHit[];
}

export interface UsefulnessArmOutput {
  armId: string;
  home: string;
  dbPath: string;
  configPath: string;
  embedderDir: string;
  results: ArmRetrieval[];
}

export type FactVerdict = "stated" | "missing" | "contradicted";

export interface AnswerScore {
  recall: number;
  contradiction: number;
}

export type Verdict = "PASS" | "FAIL" | "NO VERDICT";

export interface ProbeSummary {
  oracleRecall: number;
  oracleZeroContraShare: number;
  nullCleanShare: number;
  negationContra: number;
  regradeAgreement: number;
  pass: boolean;
  failures: string[];
}

export interface GateResult {
  verdict: Verdict;
  reason: string;
  n: number;
  recall: BootstrapCI;
  contradiction: BootstrapCI;
}

export interface QuestionOutcome {
  questionId: string;
  set: "exposed" | "control";
  exposedTo: string[];
  excluded: null | "degraded" | "ungraded";
  // Traces enough of the retrieval that a FAIL is explainable without ever
  // storing full hit content (spec §7): which sessions each arm actually
  // surfaced, and why some of the top 30 never reached the top 8.
  retrieved: Partial<
    Record<RetrievalArm, { sessionIds: string[]; method: "embedding" | "tfidf"; degraded: boolean; droppedNonSession: number; droppedLeak: number }>
  >;
  answers: Partial<Record<UsefulnessArm, string>>;
  // Per-fact grades, one array per arm that was graded.
  verdicts: Partial<Record<UsefulnessArm, FactVerdict[]>>;
  scores: Partial<Record<UsefulnessArm, AnswerScore>>;
}

export interface RunRecord {
  createdAt: string;
  git: { sha: string; dirty: boolean };
  seed: number;
  rejectSet: { sessionIds: string[]; sha256: string };
  questionsSha256: string;
  prompts: { miner: string; grader: string; negation: string };
  model: string;
  // The model synthesize() actually used for answers, resolved once per run
  // (spec §8: the answer cache key needs this to invalidate on a model change).
  answerModel: string;
  arms: Record<RetrievalArm, ArmSpec>;
  // false when the run skipped the report-only none arm (--skip-none).
  noneArm: boolean;
  sampled: { exposed: number; control: number; minedTotal: number; exposedAvailable: number };
  excluded: { degraded: number; ungraded: number };
  probes: ProbeSummary;
  gate: GateResult;
  report: {
    fullVsNoneRecall: BootstrapCI;
    controlRecall: BootstrapCI;
    controlContradiction: BootstrapCI;
    perRejectExposure: Record<string, number>;
    worse: string[];
  };
  questions: QuestionOutcome[];
}
