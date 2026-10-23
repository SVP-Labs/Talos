import { z } from 'zod';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const relativePath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), {
    message: 'must be a path inside the repository',
  });

const exception = z.strictObject({
  reason: z.string().min(1),
  expires: z.string().regex(DATE, 'must be a date, YYYY-MM-DD'),
});

const component = z.strictObject({
  lang: z.enum(['ts', 'py', 'php', 'lua', 'rust']),
  root: relativePath.default('.'),
  os: z
    .array(z.enum(['linux', 'windows', 'macos']))
    .min(1)
    .default(['linux']),
});

const service = z.strictObject({
  image: z.string().regex(/@sha256:[0-9a-f]{64}$/, 'must be pinned by digest (image@sha256:…)'),
  env: z.record(z.string(), z.string()).default({}),
  ports: z.array(z.number().int().positive()).default([]),
});

const customCheck = z.strictObject({
  run: z.string().min(1),
  scope: z.enum(['commit', 'head']).default('head'),
});

export const talosConfigSchema = z.strictObject({
  name: z.string().min(1),
  prefix: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{0,5}$/, 'must be 1 to 6 capitals or digits, a capital first'),
  components: z.array(component).default([]),
  exclude: z.array(relativePath).default([]),
  tests: z.strictObject({ full: z.array(relativePath).default([]) }).default({ full: [] }),
  services: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), service).default({}),
  setup: relativePath.optional(),
  mutation: z.array(relativePath).default([]),
  size: relativePath.optional(),
  licences: z.record(z.string().min(1), z.string().min(1)).default({}),
  docs: z
    .strictObject({
      glossary: relativePath.default('docs/glossary.md'),
      briefs: relativePath.default('docs/requirements'),
    })
    .default({ glossary: 'docs/glossary.md', briefs: 'docs/requirements' }),
  protected: z.array(z.string().min(1)).default([]),
  checks: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), customCheck).default({}),
  agents: z
    .strictObject({ max_claims: z.number().int().min(1).max(10).default(2) })
    .default({ max_claims: 2 }),
  supply_chain: z
    .strictObject({
      allow: z
        .record(z.string().regex(/^.+@[^@]+$/, 'must be name@version'), exception)
        .default({}),
      exceptions: z.record(z.string().min(1), exception).default({}),
    })
    .default({ allow: {}, exceptions: {} }),
});

export type TalosConfig = z.infer<typeof talosConfigSchema>;
export type ServiceConfig = z.infer<typeof service>;
export type ExceptionEntry = z.infer<typeof exception>;
