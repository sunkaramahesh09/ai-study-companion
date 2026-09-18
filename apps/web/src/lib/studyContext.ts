import { useEffect, useState } from 'react';
import type { Project, Space } from '@asc/shared';
import { listProjects, listSpaces } from './queries.ts';

/**
 * "Where was I last?" — the space and project the learner most recently worked
 * in, plus everything needed to switch to a different one.
 *
 * The source of truth is the server, not localStorage: `GET /api/projects`
 * already returns every project ordered by `last_active_at` descending, which
 * is exactly this question, and every page that opens a project POSTs
 * `/touch`. Deriving it means it follows the learner to another browser, it
 * cannot point at a project that was deleted or that belongs to a different
 * account signed in on the same machine, and there is no second copy of the
 * truth to keep in sync. See D-065.
 */
export type StudyContext = { project: Project; space: Space | null };

export type StudyContextState = {
  spaces: Space[];
  projects: Project[];
  loading: boolean;
  error: unknown;
  current: StudyContext | null;
};

export function useStudyContext(projectId?: string): StudyContextState {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listSpaces(), listProjects()])
      .then(([s, p]) => {
        if (cancelled) return;
        setSpaces(s);
        setProjects(p);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loading = !error && (spaces === null || projects === null);

  // With a projectId this describes *that* project; without one it answers
  // "the last one you used", which is the first row of the ordered list.
  const project = projectId
    ? (projects?.find((p) => p.id === projectId) ?? null)
    : (projects?.[0] ?? null);

  const current: StudyContext | null = project
    ? { project, space: spaces?.find((s) => s.id === project.spaceId) ?? null }
    : null;

  return { spaces: spaces ?? [], projects: projects ?? [], loading, error, current };
}
