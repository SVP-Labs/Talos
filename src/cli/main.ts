import { type Command, type Io, UsageError } from './io.js';

type Entry = { readonly summary: string; load(): Promise<Command> };

/** Every command, loaded only when it runs. */
const COMMANDS: Readonly<Record<string, Entry>> = {
  check: {
    summary: 'what the gate would say, before a push',
    load: async () => (await import('./check.js')).check,
  },
  run: {
    summary: 'one gate job: the checks at this checkout',
    load: async () => (await import('./run.js')).run,
  },
  plan: {
    summary: "the gate's plan for its event",
    load: async () => (await import('./plan.js')).plan,
  },
  verdict: {
    summary: "the gate's verdict from its runs",
    load: async () => (await import('./verdict.js')).verdict,
  },
  status: {
    summary: "a repository's state as compact JSON",
    load: async () => (await import('./status.js')).status,
  },
  why: {
    summary: 'the PR that last changed a path, and why',
    load: async () => (await import('./why.js')).why,
  },
  debt: {
    summary: 'the findings on the default branch',
    load: async () => (await import('./debt.js')).debt,
  },
  doctor: {
    summary: 'whether this machine and repository are set up',
    load: async () => (await import('./doctor.js')).doctor,
  },
  configs: {
    summary: 'write the generated tool configs',
    load: async () => (await import('./configs.js')).configs,
  },
  adopt: {
    summary: 'bring a repository under Talos: its files',
    load: async () => (await import('./adopt.js')).adopt,
  },
  govern: {
    summary: 'bring a repository under Talos: its settings',
    load: async () => (await import('./govern.js')).govern,
  },
  new: {
    summary: 'create a repository and govern it',
    load: async () => (await import('./new.js')).newRepo,
  },
  ticket: {
    summary: 'claim, release and inspect tickets',
    load: async () => (await import('./ticket.js')).ticket,
  },
  job: {
    summary: 'the caller workflow: one job per event',
    load: async () => (await import('./job.js')).job,
  },
  central: {
    summary: "Talos's central jobs: sweep, drift, channels",
    load: async () => (await import('./central.js')).central,
  },
  org: {
    summary: "the organisation's rulesets and pins",
    load: async () => (await import('./org.js')).org,
  },
  'self-test': {
    summary: "every check against Talos's test projects",
    load: async () => (await import('./self-test.js')).selfTest,
  },
  version: {
    summary: 'the version of this Talos',
    load: async () => (await import('./version.js')).version,
  },
};

function usage(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, entry]) => `  ${name.padEnd(width)}  ${entry.summary}`,
  );
  return `usage: talos <command> [options]\n\n${lines.join('\n')}\n`;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  const entry = name === undefined ? undefined : COMMANDS[name];
  if (entry === undefined) {
    io.err(usage());
    return name === undefined || name === 'help' || name === '--help' ? 0 : 3;
  }
  try {
    return await (
      await entry.load()
    )(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`talos ${name ?? ''}: ${error.message}\n`);
      return 3;
    }
    io.err(`talos ${name ?? ''}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
