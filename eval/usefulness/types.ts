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
  answers: Partial<Record<UsefulnessArm, string>>;
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
