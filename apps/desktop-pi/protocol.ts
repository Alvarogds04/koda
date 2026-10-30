/** Question extension QP/1. Legacy v1 frames are deliberately not widened. */
export interface Scope {
  v: 1;
  project: string;
  sessionId: string;
  at: number;
}
export interface Option { value: string; label: string; description: string }
export type HumanAnswer = { type: 'option'; value: string } | { type: 'text'; text: string };
export type BusyReason = 'native_transition_busy' | 'native_transition_degraded';
export interface QuestionsHello extends Scope { type: 'questions_hello'; questionVersion: 1; busyReason?: 1 }
export interface QuestionsReady { v: 1; type: 'questions_ready'; questionVersion: 1; busyReason?: 1 }
export interface Question extends Scope {
  type: 'question'; questionVersion: 1; id: string; kind: 'question' | 'approval';
  text: string; options: Option[]; allowFreeText: boolean; expiresAt: number;
  /** OPTIONAL (P1). Who is asking; absent = "pi". `[a-z0-9][a-z0-9._-]{0,31}`; anything else refuses the whole frame. */
  agent?: string;
}
export interface Answer extends Scope {
  type: 'answer'; questionVersion: 1; id: string; source: 'human'; answer: HumanAnswer;
}
export type QuestionClosed = Scope & { type: 'question_closed'; questionVersion: 1; id: string } & (
  { source: 'human'; reason: 'cancelled'; busyReason?: never } |
  { source: 'system'; reason: 'cancelled' | 'expired'; busyReason?: never } |
  { source: 'system'; reason: 'busy'; busyReason?: BusyReason }
);
export interface QuestionCancel extends Scope {
  type: 'question_cancel'; questionVersion: 1; id: string; reason: 'cancelled' | 'expired';
}
export interface QuestionResolved extends Scope {
  type: 'question_resolved'; questionVersion: 1; id: string; status: 'answered' | 'human_cancelled';
}
export interface QuestionAnswerRejected extends Scope {
  type: 'question_answer_rejected'; questionVersion: 1; id: string;
  reason: 'not_live' | 'invalid_answer' | 'scope_mismatch';
}
export type ProducerFrame = QuestionsHello | Question | QuestionCancel | QuestionResolved | QuestionAnswerRejected;
export type ReceiverFrame = QuestionsReady | Answer | QuestionClosed;
export interface AskRequest {
  kind: 'question' | 'approval'; text: string; options: Option[];
  allowFreeText?: boolean; timeoutMs?: number;
}
export type AskResult = { status: 'answered'; id: string; answer: HumanAnswer } |
  { status: 'expired' | 'cancelled' | 'human_cancelled' | 'disconnected' | 'session_changed'; id?: string } |
  { status: 'busy'; id?: string; reasonCode?: BusyReason } |
  { status: 'protocol_error'; id: string; reasonCode: 'invalid_answer' | 'scope_mismatch' | 'invalid_frame' } |
  { status: 'unavailable' | 'invalid_request' } | { status: 'unsupported_receiver'; runtime: string };
