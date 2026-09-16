import type { FastifyPluginAsync } from 'fastify';

export const meRoutes: FastifyPluginAsync = async (app) => {
  // Who am I? Used by the frontend to confirm the session and learn the role.
  app.get('/api/me', { preHandler: app.requireAuth }, async (req) => ({
    user: req.user,
  }));

  // Exists so the admin gate is testable before the dashboard is built.
  app.get('/api/admin/ping', { preHandler: app.requireAdmin }, async (req) => ({
    ok: true,
    role: req.user?.role,
  }));
};
