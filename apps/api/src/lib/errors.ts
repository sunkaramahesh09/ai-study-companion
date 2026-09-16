import type { FastifyReply } from 'fastify';
import { ZodError, type ZodType } from 'zod';

/**
 * Parses a request payload, replying 400 with field-level detail on failure.
 * Returns undefined when it has already replied, so callers `return` early.
 */
export function parseOrReply<T>(schema: ZodType<T>, data: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  reply.code(400).send({
    error: 'invalid_request',
    message: 'The request could not be validated.',
    fields: result.error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    })),
  });
  return undefined;
}

/**
 * Maps a PostgREST error to a status code.
 *
 * PGRST116 ("no rows") is the shape an RLS-filtered read takes: to the database
 * the row does not exist for this caller. Returning 404 rather than 403 is
 * deliberate — telling an unauthorized caller that an id exists but is not
 * theirs is itself a disclosure.
 */
export function replyDbError(reply: FastifyReply, error: { code?: string; message: string }): void {
  if (error.code === 'PGRST116') {
    reply.code(404).send({ error: 'not_found', message: 'Not found.' });
    return;
  }
  if (error.code === '23505') {
    reply.code(409).send({ error: 'conflict', message: 'That already exists.' });
    return;
  }
  // 42501 = insufficient privilege: an RLS policy refused the write.
  if (error.code === '42501' || error.code === 'PGRST301') {
    reply.code(403).send({ error: 'forbidden', message: 'Not permitted.' });
    return;
  }
  if (error.code === '23514') {
    reply.code(400).send({ error: 'invalid_request', message: 'A value failed a database constraint.' });
    return;
  }
  reply.code(500).send({ error: 'server_error', message: 'Something went wrong.' });
}

export function isZodError(e: unknown): e is ZodError {
  return e instanceof ZodError;
}
