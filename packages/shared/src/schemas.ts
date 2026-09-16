import { z } from 'zod';

/**
 * Validation schemas shared by the API and the frontend.
 *
 * Defined once so a field constraint cannot drift between the form that
 * enforces it and the route that trusts it. The API always re-validates —
 * client-side checks are a convenience, never a control.
 *
 * Limits mirror the CHECK constraints in the migrations (D-008): the database
 * is the final authority, and these exist to produce a readable error before a
 * request gets that far.
 */

const trimmedName = z
  .string()
  .trim()
  .min(1, 'Name is required.')
  .max(120, 'Name must be 120 characters or fewer.');

/**
 * An optional free-text field where an empty string means "not provided".
 *
 * preprocess-then-optional, not optional-then-transform: a `.transform()` on an
 * optional still infers a REQUIRED key holding `undefined`, which forces every
 * caller to pass `description: undefined` explicitly. Normalizing before
 * validation keeps the key genuinely optional.
 */
const optionalText = (max: number, label: string) =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z
      .string()
      .trim()
      .max(max, `${label} must be ${max} characters or fewer.`)
      .optional(),
  );

// ---------------------------------------------------------------------------
// Spaces
// ---------------------------------------------------------------------------

export const spaceCreateSchema = z.object({
  name: trimmedName,
  description: optionalText(2000, 'Description'),
  // Hex colour for the space card. Validated so a stray value cannot end up
  // interpolated into a style attribute.
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Colour must be a hex value like #6d8cff.')
    .optional(),
  icon: z.string().trim().max(16).optional(),
});

export const spaceUpdateSchema = spaceCreateSchema.partial().refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: 'Provide at least one field to update.' },
);

export type SpaceCreateInput = z.infer<typeof spaceCreateSchema>;
export type SpaceUpdateInput = z.infer<typeof spaceUpdateSchema>;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projectCreateSchema = z.object({
  spaceId: z.string().uuid('spaceId must be a UUID.'),
  name: trimmedName,
  description: optionalText(2000, 'Description'),
  /**
   * The learning goal. Optional at the schema level because the PRD does not
   * state it is mandatory (§4 lists it among what "the user provides"), but the
   * UI asks for it: it feeds Tutor context and recommendation generation, and a
   * Project without one produces noticeably weaker recommendations.
   */
  goal: optionalText(2000, 'Goal'),
});

export const projectUpdateSchema = z
  .object({
    name: trimmedName.optional(),
    description: optionalText(2000, 'Description'),
    goal: optionalText(2000, 'Goal'),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'Provide at least one field to update.',
  });

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

// ---------------------------------------------------------------------------
// Shared response shapes
// ---------------------------------------------------------------------------

export const uuidParamSchema = z.object({ id: z.string().uuid('Not a valid id.') });

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Space = {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
  projectCount?: number;
};

export type Project = {
  id: string;
  spaceId: string;
  name: string;
  description: string | null;
  goal: string | null;
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
};
