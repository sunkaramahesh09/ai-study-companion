import type { Project, ProjectCreateInput, Space, SpaceCreateInput } from '@asc/shared';
import { api } from './api.ts';

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
