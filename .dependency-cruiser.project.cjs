/**
 * Talos's own architecture: the engine's core knows no check, no job and no command; checks know
 * the core but not each other's packs; nothing below the CLI imports it.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-stands-alone',
      comment: 'The core is the vocabulary every pack speaks; only its registry lists the packs.',
      severity: 'error',
      from: { path: '^src/core/', pathNot: '^src/core/registry\\.ts$' },
      to: { path: '^src/(cli|engine|langs|checks|jobs|review|ticket|status|adopt|govern|central)/' },
    },
    {
      name: 'packs-stay-apart',
      comment: 'A language pack shares code with another only through quality/, configs/ or core/.',
      severity: 'error',
      from: { path: '^src/langs/([^/]+)/' },
      to: { path: '^src/langs/', pathNot: '^src/langs/$1/' },
    },
    {
      name: 'cli-on-top',
      comment: 'Commands are the top layer; nothing below them imports one.',
      severity: 'error',
      from: { pathNot: '^src/(cli|bin)/' },
      to: { path: '^src/cli/' },
    },
  ],
};
