import type { Project, ProjectCreateInput, Space, SpaceCreateInput } from '@asc/shared';
import { api } from './api.ts';
import { normalizeBaseUrl } from './baseUrl.ts';
import { supabase } from './supabase.ts';

/**
 * Typed wrappers over the API. Keeping the endpoint strings in one file means a
 * route rename is a single edit, and the shared input types come straight from
 * the same zod schemas the server validates with.
 */

export const listSpaces = () => api<{ spaces: Space[] }>('/api/spaces').then((r) => r.spaces);

export const createSpace = (input: SpaceCreateInput) =>
  api<{ space: Space }>('/api/spaces', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.space);

export const deleteSpace = (id: string) =>
  api<void>(`/api/spaces/${id}`, { method: 'DELETE' });

export const listProjects = (spaceId?: string) =>
  api<{ projects: Project[] }>(`/api/projects${spaceId ? `?spaceId=${spaceId}` : ''}`).then((r) => r.projects);

export const createProject = (input: ProjectCreateInput) =>
  api<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.project);

export type MaterialSummary = {
  id: string;
  filename: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  page_count: number | null;
  chunk_count: number;
  /** Set when status is 'failed'. Always a readable message, never a stack trace. */
  error_message: string | null;
  created_at: string;
};

export type MasteryRow = {
  concept_id: string;
  score: number;
  evidence_count: number;
  concepts: { name: string } | null;
};

export type RecommendationRow = {
  id: string;
  title: string;
  body: string;
  action_type: string;
  created_at: string;
};

export type ActivityRow = {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type ProjectDashboard = {
  project: Project;
  materials: MaterialSummary[];
  conceptCount: number;
  mastery: MasteryRow[];
  recommendations: RecommendationRow[];
  recentActivity: ActivityRow[];
};

export const getProject = (id: string) => api<ProjectDashboard>(`/api/projects/${id}`);

export const touchProject = (id: string) =>
  api<{ ok: boolean }>(`/api/projects/${id}/touch`, { method: 'POST' });

export const listMaterials = (projectId: string) =>
  api<{ materials: MaterialSummary[] }>(`/api/materials?projectId=${projectId}`).then((r) => r.materials);

export const retryMaterial = (id: string) =>
  api<{ ok: boolean }>(`/api/materials/${id}/retry`, { method: 'POST' });

export const deleteMaterial = (id: string) => api<void>(`/api/materials/${id}`, { method: 'DELETE' });

/**
 * Uploads via XMLHttpRequest rather than fetch, because fetch still has no
 * upload progress event and a 25 MB PDF on a slow connection needs one.
 */
export async function uploadMaterial(
  projectId: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<MaterialSummary> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const base = normalizeBaseUrl(import.meta.env.VITE_API_BASE_URL);

  const form = new FormData();
  // projectId must precede the file: the server reads fields alongside the
  // stream, and a field after the file would not be available yet.
  form.append('projectId', projectId);
  form.append('file', file);

  return await new Promise<MaterialSummary>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/api/materials`);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { material?: MaterialSummary; message?: string };
        if (xhr.status >= 200 && xhr.status < 300 && body.material) resolve(body.material);
        else reject(new Error(body.message ?? `Upload failed (${xhr.status})`));
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(form);
  });
}

export type CitationDto = {
  sourceId: number;
  materialId: string;
  filename: string;
  pageNumber: number;
  chunkId: string;
  snippet: string;
};

export type TutorMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: CitationDto[];
  grounded: boolean | null;
  /**
   * Which half of the Tutor answered. `progress` turns are grounded in the
   * learner's own record rather than in a document, so they carry no citations
   * — and must not be labelled as an answer that failed to find any. NULL on
   * turns written before the progress path existed (migration 0009).
   */
  mode: 'material' | 'progress' | null;
  created_at: string;
};

export type AskResponse = {
  conversationId: string;
  message: TutorMessage;
  grounded: boolean;
  reason: 'ok' | 'no_materials' | 'not_indexed' | 'no_relevant_evidence' | 'progress';
  mode: 'material' | 'progress';
  diagnostics: {
    retrieved: number;
    bestDistance: number | null;
    model: string | null;
    usedFallback: boolean;
    latencyMs: number;
  };
};

export const askTutor = (projectId: string, question: string, conversationId?: string) =>
  api<AskResponse>('/api/tutor/ask', {
    method: 'POST',
    body: JSON.stringify({ projectId, question, conversationId }),
  });

export const listConversations = (projectId: string) =>
  api<{ conversations: { id: string; title: string | null; updated_at: string }[] }>(
    `/api/conversations?projectId=${projectId}`,
  ).then((r) => r.conversations);

export const getMessages = (conversationId: string) =>
  api<{ messages: TutorMessage[] }>(`/api/conversations/${conversationId}/messages`).then((r) => r.messages);

// --- quiz -----------------------------------------------------------------

export type QuizQuestion = {
  id: string;
  position: number;
  question_type: 'mcq' | 'open';
  difficulty: number;
  prompt: string;
  options: string[] | null;
  concept_id: string;
  conceptName?: string;
};

export type QuizAttempt = {
  id: string;
  target_length: number;
  questions_answered: number;
  correct_count: number;
  status: string;
};

export type AnswerResult = {
  isCorrect: boolean;
  score: number;
  questionType: 'mcq' | 'open';
  correctIndex?: number;
  explanation?: string | null;
  grade?: { score: number; understood: string[]; missing: string[]; feedback: string };
  mastery: { conceptId: string; before: number; after: number; delta: number } | null;
  progress: { answered: number; correct: number; target: number };
  finished: boolean;
  question: QuizQuestion | null;
  /**
   * True when the attempt continues and the next question has NOT been
   * generated yet. The verdict is returned without waiting for it, so the
   * client fetches it separately — see `nextQuizQuestion`.
   */
  nextPending?: boolean;
  endedEarly?: boolean;
};

export type NextQuestionResult = {
  finished: boolean;
  question: QuizQuestion | null;
  score?: number;
  reissued?: boolean;
  endedEarly?: boolean;
};

export const startQuiz = (projectId: string, targetLength = 5) =>
  api<{ attempt: QuizAttempt; question: QuizQuestion }>('/api/quizzes', {
    method: 'POST',
    body: JSON.stringify({ projectId, targetLength }),
  });

export const answerQuiz = (
  attemptId: string,
  body: { questionId: string; selectedIndex?: number; text?: string },
) => api<AnswerResult>(`/api/quizzes/${attemptId}/answer`, { method: 'POST', body: JSON.stringify(body) });

/**
 * Asks for the next question. Idempotent: an unanswered question that was
 * already issued comes back unchanged, so a retry cannot skip a question or
 * spend quota twice.
 */
export const nextQuizQuestion = (attemptId: string) =>
  api<NextQuestionResult>(`/api/quizzes/${attemptId}/next`, { method: 'POST' });

/**
 * Fetches an existing attempt so it can be resumed — e.g. after `startQuiz`
 * 409s because one is already in progress. Unanswered questions come back
 * with `correct_index` stripped, same as everywhere else.
 */
export const getQuizAttempt = (attemptId: string) =>
  api<{ attempt: QuizAttempt; questions: (QuizQuestion & { answered_at: string | null })[] }>(
    `/api/quizzes/${attemptId}`,
  );

export const abandonQuiz = (attemptId: string) =>
  api<{ ok: boolean }>(`/api/quizzes/${attemptId}/abandon`, { method: 'POST' });

// --- flashcards ------------------------------------------------------------

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

export type Flashcard = {
  id: string;
  conceptId: string | null;
  conceptName: string | null;
  front: string;
  back: string;
  hint: string | null;
  dueAt: string;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  lastRating: ReviewRating | null;
  lastReviewedAt: string | null;
  createdAt: string;
};

export type FlashcardDeck = {
  project: { id: string; name: string };
  cards: Flashcard[];
  /** The review queue, most overdue first. Derived on read, never stored. */
  due: Flashcard[];
  nextDueAt: string | null;
  totals: { cards: number; due: number; learned: number };
};

export const getFlashcards = (projectId: string) =>
  api<FlashcardDeck>(`/api/projects/${projectId}/flashcards`);

/**
 * Asks for more cards. Slow by design — one model call per concept, run
 * sequentially behind the TPM limiter — which is why `timeoutFor` gives this
 * path the long timeout.
 */
export type GenerateDeckResult = {
  cards: Flashcard[];
  failures: { concept: string; reason: string }[];
  /** Present when the model wrote nothing the deck did not already have. */
  message?: string;
};

export const generateFlashcards = (projectId: string, count = 6, conceptId?: string) =>
  api<GenerateDeckResult>(
    `/api/projects/${projectId}/flashcards/generate`,
    { method: 'POST', body: JSON.stringify({ count, ...(conceptId ? { conceptId } : {}) }) },
  );

/** The rating is all the client sends — the schedule is computed server side. */
export const reviewFlashcard = (cardId: string, rating: ReviewRating) =>
  api<{ card: Flashcard }>(`/api/flashcards/${cardId}/review`, {
    method: 'POST',
    body: JSON.stringify({ rating }),
  });

export const deleteFlashcard = (cardId: string) =>
  api<void>(`/api/flashcards/${cardId}`, { method: 'DELETE' });

// --- growth ----------------------------------------------------------------

export type GrowthTrend = 'new' | 'improving' | 'stable' | 'needs_attention';

export type ConceptGrowth = {
  conceptId: string;
  name: string;
  description: string | null;
  score: number;
  evidenceCount: number;
  confidence: number;
  band: 'unassessed' | 'needs_work' | 'developing' | 'secure';
  growth: { trend: GrowthTrend; delta: number; from: number; to: number; points: number; summary: string };
  history: { score: number; at: string }[];
};

export type GrowthResponse = {
  project: { id: string; name: string };
  concepts: ConceptGrowth[];
  summary: {
    total: number;
    assessed: number;
    improving: number;
    stable: number;
    needsAttention: number;
    averageMastery: number | null;
  };
};

export const getGrowth = (projectId: string) => api<GrowthResponse>(`/api/projects/${projectId}/growth`);

export type Recommendation = {
  id: string;
  title: string;
  body: string;
  action_type: 'review_material' | 'take_quiz' | 'ask_tutor' | 'upload_material';
  trigger_reason: string;
  concept_id: string | null;
  created_at: string;
};

export const getRecommendations = (projectId: string) =>
  api<{ recommendations: Recommendation[] }>(`/api/projects/${projectId}/recommendations`).then((r) => r.recommendations);

export const resolveRecommendation = (id: string, status: 'dismissed' | 'completed') =>
  api<{ ok: boolean }>(`/api/recommendations/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });

// --- analytics -------------------------------------------------------------

export type DayBucket = { date: string; total: number; byType: Record<string, number> };
export type StudyStreak = { current: number; longest: number; activeDays: number };

export type AssessmentSummary = {
  answered: number;
  correct: number;
  accuracy: number | null;
  averageDifficulty: number | null;
  byType: Record<'mcq' | 'open', { answered: number; correct: number; accuracy: number | null }>;
  byDifficulty: { difficulty: number; answered: number; correct: number; accuracy: number | null }[];
  recentAccuracy: number | null;
  priorAccuracy: number | null;
};

export type AiUsageSummary = {
  requests: number;
  successes: number;
  failures: number;
  successRate: number | null;
  totalTokens: number;
  estimatedCostUsd: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  fallbackRate: number | null;
  byFeature: { feature: string; requests: number; totalTokens: number; estimatedCostUsd: number }[];
  byModel: { model: string; requests: number; totalTokens: number }[];
};

export type ActivitySummary = {
  buckets: DayBucket[];
  /**
   * Absent on the admin overview. A streak is a learner's own run of days;
   * "consecutive days on which SOMEONE used the platform" is not the same
   * measure and is not worth showing. The type said it was always present,
   * which is how `activity.streak.current` reached production and crashed the
   * Admin Dashboard on open (D-072).
   */
  streak?: StudyStreak;
  totalEvents: number;
  byType: Record<string, number>;
};

export type TutorSummary = { answered: number; refused: number; rate: number | null };

export type ProjectAnalytics = {
  project: { id: string; name: string };
  window: { days: number; since: string };
  activity: ActivitySummary;
  assessment: AssessmentSummary & {
    attempts: {
      total: number;
      completed: number;
      abandoned: number;
      inProgress: number;
      averageScore: number | null;
    };
  };
  mastery: { concepts: number; assessed: number; average: number | null };
  tutor: TutorSummary;
  ai: AiUsageSummary;
};

export type GlobalAnalytics = {
  window: { days: number; since: string };
  totals: { spaces: number; projects: number };
  activity: ActivitySummary;
  assessment: AssessmentSummary;
  tutor: TutorSummary;
  // No `ai` here, unlike ProjectAnalytics: the endpoint no longer sends one.
  // Account-wide AI spend is an Admin view (PRD §16); per-Project AI activity
  // is a learner view (§12). See D-076.
  projects: { id: string; name: string; spaceId: string; events: number }[];
};

export const getProjectAnalytics = (projectId: string, days: number) =>
  api<ProjectAnalytics>(`/api/projects/${projectId}/analytics?days=${days}`);

export const getGlobalAnalytics = (days: number) =>
  api<GlobalAnalytics>(`/api/analytics?days=${days}`);

// --- admin -----------------------------------------------------------------

export type AdminOverview = {
  window: { days: number; since: string };
  users: { total: number; admins: number; newInWindow: number };
  content: {
    spaces: number;
    projects: number;
    materials: number;
    materialsByStatus: Record<string, number>;
  };
  activity: ActivitySummary;
  tutor: TutorSummary;
  ai: AiUsageSummary;
  jobs: {
    available: boolean;
    error: string | null;
    queues: { name: string; queued: number; active: number; failed: number; total: number }[];
  };
  evaluation: { runs: EvalRun[]; lastRunAt: string | null };
};

export type AdminUser = {
  id: string;
  email: string | null;
  role: string;
  createdAt: string;
  spaces: number;
  projects: number;
  events: number;
  tokens: number;
  estimatedCostUsd: number;
};

export type AdminEvent = {
  id: string;
  user_id: string;
  project_id: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type AiFailure = {
  id: string;
  user_id: string | null;
  project_id: string | null;
  feature: string;
  model: string;
  status: string;
  latency_ms: number | null;
  attempt_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
};

export type EvalRun = {
  id: string;
  git_sha: string | null;
  notes: string | null;
  summary: Record<string, { passed?: number; failed?: number; mean_score?: number }>;
  started_at: string;
  finished_at: string | null;
  incomplete?: boolean;
};

export type EvalResult = {
  id: string;
  suite: string;
  case_id: string;
  passed: boolean;
  score: number | null;
  detail: Record<string, unknown>;
  created_at: string;
};

export type ActivityFilters = { days?: number; userId?: string; projectId?: string; type?: string };

export const getAdminOverview = (days: number) =>
  api<AdminOverview>(`/api/admin/overview?days=${days}`);

export const getAdminUsers = () => api<{ users: AdminUser[] }>('/api/admin/users').then((r) => r.users);

export const getAdminActivity = (filters: ActivityFilters) => {
  const q = new URLSearchParams();
  if (filters.days) q.set('days', String(filters.days));
  if (filters.userId) q.set('userId', filters.userId);
  if (filters.projectId) q.set('projectId', filters.projectId);
  if (filters.type) q.set('type', filters.type);
  return api<{ events: AdminEvent[] }>(`/api/admin/activity?${q}`).then((r) => r.events);
};

export const getAdminAi = (days: number) =>
  api<{ window: { days: number }; summary: AiUsageSummary; recentFailures: AiFailure[] }>(
    `/api/admin/ai?days=${days}`,
  );

export const getAdminEvals = () =>
  api<{ runs: EvalRun[]; latestResults: EvalResult[]; latestRunId: string | null }>('/api/admin/evals');
