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
  created_at: string;
};

export type AskResponse = {
  conversationId: string;
  message: TutorMessage;
  grounded: boolean;
  reason: 'ok' | 'no_materials' | 'not_indexed' | 'no_relevant_evidence';
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

export const abandonQuiz = (attemptId: string) =>
  api<{ ok: boolean }>(`/api/quizzes/${attemptId}/abandon`, { method: 'POST' });

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
