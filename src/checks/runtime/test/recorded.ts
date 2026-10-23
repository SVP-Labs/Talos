import type { FeedRequest, Fetcher } from '../fetchers.js';

/**
 * Excerpts of the vendors' feeds as they answered on 2026-10-23, the day after php2shell's fix
 * shipped: a few cycles each, the fields Talos reads and some it ignores.
 */
export const TODAY = '2026-10-23';

const generated = { schema_version: '1.2.1', generated_at: '2026-10-23T00:09:42+00:00' };

export const ENDOFLIFE_PHP = {
  ...generated,
  result: {
    name: 'php',
    releases: [
      {
        name: '8.5',
        releaseDate: '2025-11-20',
        isEoas: false,
        eoasFrom: '2027-12-31',
        isEol: false,
        eolFrom: '2029-12-31',
        isMaintained: true,
        latest: {
          name: '8.5.12',
          date: '2026-10-21',
          link: 'https://www.php.net/ChangeLog-8.php#8.5.12',
        },
      },
      {
        name: '8.4',
        releaseDate: '2024-11-21',
        isEoas: false,
        eoasFrom: '2026-12-31',
        isEol: false,
        eolFrom: '2028-12-31',
        isMaintained: true,
        latest: {
          name: '8.4.27',
          date: '2026-10-21',
          link: 'https://www.php.net/ChangeLog-8.php#8.4.27',
        },
      },
      {
        name: '8.3',
        releaseDate: '2023-11-23',
        isEoas: true,
        eoasFrom: '2025-12-31',
        isEol: false,
        eolFrom: '2027-12-31',
        isMaintained: true,
        latest: {
          name: '8.3.36',
          date: '2026-10-21',
          link: 'https://www.php.net/ChangeLog-8.php#8.3.36',
        },
      },
      {
        name: '8.2',
        releaseDate: '2022-12-08',
        isEoas: true,
        eoasFrom: '2024-12-31',
        isEol: false,
        eolFrom: '2026-12-31',
        isMaintained: true,
        latest: {
          name: '8.2.35',
          date: '2026-10-21',
          link: 'https://www.php.net/ChangeLog-8.php#8.2.35',
        },
      },
      {
        name: '8.1',
        releaseDate: '2021-11-25',
        isEoas: true,
        eoasFrom: '2023-11-25',
        isEol: true,
        eolFrom: '2025-12-31',
        isMaintained: false,
        latest: {
          name: '8.1.34',
          date: '2025-12-18',
          link: 'https://www.php.net/ChangeLog-8.php#8.1.34',
        },
      },
    ],
  },
};

const ENDOFLIFE_NODE = {
  ...generated,
  result: {
    name: 'nodejs',
    releases: [
      {
        name: '26',
        isEoas: false,
        eoasFrom: '2027-10-27',
        isEol: false,
        eolFrom: '2029-04-30',
        latest: { name: '26.12.1', date: '2026-10-21' },
      },
      {
        name: '24',
        isEoas: true,
        eoasFrom: '2026-10-20',
        isEol: false,
        eolFrom: '2028-04-30',
        latest: { name: '24.22.1', date: '2026-10-21' },
      },
      {
        name: '22',
        isEoas: true,
        eoasFrom: '2025-10-21',
        isEol: false,
        eolFrom: '2027-04-30',
        latest: { name: '22.23.4', date: '2026-10-21' },
      },
      {
        name: '20',
        isEoas: true,
        eoasFrom: '2024-10-22',
        isEol: true,
        eolFrom: '2026-04-30',
        latest: { name: '20.20.2', date: '2026-03-24' },
      },
    ],
  },
};

const ENDOFLIFE_PYTHON = {
  ...generated,
  result: {
    name: 'python',
    releases: [
      {
        name: '3.14',
        isEoas: false,
        eoasFrom: '2027-10-01',
        isEol: false,
        eolFrom: '2030-10-31',
        latest: { name: '3.14.9', date: '2026-10-21' },
      },
      {
        name: '3.13',
        isEoas: true,
        eoasFrom: '2026-10-01',
        isEol: false,
        eolFrom: '2029-10-31',
        latest: { name: '3.13.17', date: '2026-10-21' },
      },
      {
        name: '3.9',
        isEoas: true,
        eoasFrom: '2022-05-17',
        isEol: true,
        eolFrom: '2025-10-31',
        latest: { name: '3.9.25', date: '2025-10-31' },
      },
    ],
  },
};

export const ENDOFLIFE_RUST = {
  ...generated,
  result: {
    name: 'rust',
    releases: [
      {
        name: '1.99',
        isEol: false,
        eolFrom: null,
        latest: { name: '1.99.1', date: '2026-10-15' },
      },
      {
        name: '1.98',
        isEol: true,
        eolFrom: '2026-10-01',
        latest: { name: '1.98.1', date: '2026-09-03' },
      },
    ],
  },
};

const ENDOFLIFE_GO = {
  ...generated,
  result: {
    name: 'go',
    releases: [
      { name: '1.27', isEol: false, eolFrom: null, latest: { name: '1.27.3', date: '2026-10-19' } },
      { name: '1.25', isEol: true, eolFrom: '2026-08-19', latest: { name: '1.25.14' } },
    ],
  },
};

/** php.net's `?json&version=8.4`: security releases are tagged; others carry `[]` or `[""]`. */
export const PHP_RELEASES_84 = {
  '8.4.27': { announcement: true, tags: ['security'], date: '21 Oct 2026' },
  '8.4.26': { announcement: true, tags: ['security'], date: '24 Sep 2026' },
  '8.4.25': { announcement: true, tags: [''], date: '27 Aug 2026' },
  '8.4.22': { announcement: true, tags: [], date: '04 Jun 2026' },
};

const PHP_RELEASES_85 = {
  '8.5.12': { announcement: true, tags: ['security'], date: '21 Oct 2026' },
  '8.5.11': { announcement: true, tags: ['security'], date: '24 Sep 2026' },
};

const PHP_RELEASES_83 = {
  '8.3.36': { announcement: true, tags: ['security'], date: '21 Oct 2026' },
  '8.3.35': { announcement: true, tags: ['security'], date: '24 Sep 2026' },
};

const PHP_RELEASES_81 = {
  '8.1.34': { announcement: true, tags: ['security'], date: '18 Dec 2025' },
  '8.1.33': { announcement: true, tags: ['security'], date: '3 Jul 2025' },
};

export const NODE_INDEX_EXCERPT = [
  { version: 'v26.12.1', date: '2026-10-21', lts: false, security: true },
  { version: 'v24.22.1', date: '2026-10-20', lts: 'Krypton', security: true },
  { version: 'v24.22.0', date: '2026-10-14', lts: 'Krypton', security: false },
  { version: 'v22.23.4', date: '2026-10-20', lts: 'Jod', security: true },
  { version: 'v22.23.3', date: '2026-09-23', lts: 'Jod', security: false },
  { version: 'v22.12.0', date: '2024-12-02', lts: 'Jod', security: false },
];

const RECORDED: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['endoflife-php', ENDOFLIFE_PHP],
  ['endoflife-nodejs', ENDOFLIFE_NODE],
  ['endoflife-python', ENDOFLIFE_PYTHON],
  ['endoflife-rust', ENDOFLIFE_RUST],
  ['endoflife-go', ENDOFLIFE_GO],
  ['php-releases-8.4', PHP_RELEASES_84],
  ['php-releases-8.5', PHP_RELEASES_85],
  ['php-releases-8.3', PHP_RELEASES_83],
  ['php-releases-8.1', PHP_RELEASES_81],
  ['php-releases-9.0', { error: 'Unknown version' }],
  ['node-index', NODE_INDEX_EXCERPT],
]);

/** Answers from the excerpts and records each request; an unknown feed rejects. */
export function recordedFetcher(): Fetcher & { readonly requests: FeedRequest[] } {
  const requests: FeedRequest[] = [];
  const fetcher = (request: FeedRequest): Promise<string> => {
    requests.push(request);
    const body = RECORDED.get(request.name);
    return body === undefined
      ? Promise.reject(new Error(`no recorded ${request.name}`))
      : Promise.resolve(JSON.stringify(body));
  };
  return Object.assign(fetcher, { requests });
}
