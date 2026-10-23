import { CHANNELS, type Channel } from './channels.js';
import { maskCommands, type WatchedRepo } from './privacy.js';
import { CentralError } from './repos.js';
import type { GitHub } from '../github/api.js';
import { listPropertyValues, type PropertyRow } from '../github/repos.js';

/**
 * How a central job learns the repositories it reads while its public log never names them.
 * The organisation's custom property listing, read with a token that reaches no repository,
 * gives the governed repositories in id order, the order the job's matrix of indices counts in.
 * The chosen names are masked before anything else is printed, and only then handed to the
 * job's later steps through `$GITHUB_OUTPUT`, which mint a token limited to them.
 */

/** One half of an `owner/name` as GitHub allows it: nothing a workflow command could split. */
const NAME_PART = /^[\w.-]+$/;

const DIGITS = /^\d+$/;

/** Which governed repositories a job reads: one by its matrix index, or every one on a channel. */
type Selection = { readonly index: number | undefined; readonly channel: Channel | undefined };

type Wanted = { readonly index?: string | undefined; readonly channel?: string | undefined };

/**
 * The workflow's index and channel, checked before anything is read. One of them must be given:
 * a job that lost its index reads no repository rather than every one.
 */
function selection(wanted: Wanted): Selection {
  const { index, channel } = wanted;
  if (index === undefined && channel === undefined) {
    throw new CentralError('neither an index nor a channel selects a repository');
  }
  if (index !== undefined && !DIGITS.test(index)) throw new CentralError('the index is no number');
  const named = CHANNELS.find((known) => known === channel);
  if (channel !== undefined && named === undefined) throw new CentralError('no such channel');
  return { index: index === undefined ? undefined : Number(index), channel: named };
}

/** The channel a repository's `talos` property names, if it names one. */
function channelOf(row: PropertyRow): Channel | undefined {
  const value = row.properties.talos;
  return CHANNELS.find((known) => known === value);
}

/** The governed repositories the selection names, in id order. */
function chosen(rows: readonly PropertyRow[], wanted: Selection): PropertyRow[] {
  const governed = rows
    .filter((row) => {
      const channel = channelOf(row);
      return channel !== undefined && (wanted.channel ?? channel) === channel;
    })
    .sort((a, b) => a.id - b.id);
  return wanted.index === undefined ? governed : governed.slice(wanted.index, wanted.index + 1);
}

/** A repository's names, refused unless both halves of its `owner/name` are plain names. */
function namesOf(row: PropertyRow): WatchedRepo & { readonly name: string } {
  const [owner = '', name = '', ...rest] = row.fullName.split('/');
  if (rest.length > 0 || !NAME_PART.test(owner) || !NAME_PART.test(name)) {
    throw new CentralError('the listing holds a name GitHub does not give a repository');
  }
  return { fullName: row.fullName, name };
}

type PickDeps = Wanted & {
  /** A token of the organisation's custom property values: Custom properties read. */
  readonly properties: GitHub;
  readonly org: string;
  /** Where the masks go: the runner reads them from this step's output. */
  readonly out: (text: string) => void;
  /** Hands a value to the job's later steps (`$GITHUB_OUTPUT`), which never prints it. */
  readonly output: (key: string, value: string) => Promise<void>;
};

/**
 * Masks the full and bare name of each repository the job reads, then hands the bare names on,
 * comma-separated (`names`, empty when there are none). Counts only come back.
 */
export async function pickRepositories(deps: PickDeps): Promise<{ readonly repositories: number }> {
  const wanted = selection(deps);
  const rows = chosen(await listPropertyValues(deps.properties, deps.org), wanted);
  const picked = rows.map((row) => namesOf(row));
  if (picked.length > 0) deps.out(maskCommands(picked));
  await deps.output('names', picked.map((repo) => repo.name).join(','));
  return { repositories: picked.length };
}
