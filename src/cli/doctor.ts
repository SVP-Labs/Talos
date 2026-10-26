import { type Command, parse } from './io.js';
import { exec } from '../exec/exec.js';
import { type DoctorItem, doctorReport } from '../status/doctor.js';
import { ownVersion, requiredNode } from '../version/self.js';

const MARK: Readonly<Record<DoctorItem['status'], string>> = {
  ok: 'ok  ',
  warn: 'warn',
  fail: 'FAIL',
  skip: 'skip',
};

function line(item: DoctorItem): string {
  return `${MARK[item.status]}  ${item.id.padEnd(16)} ${item.detail}`;
}

/**
 * `talos doctor [--json]`: whether this machine and repository are set up: Node and git, the
 * GitHub CLI and a token, `talos.yml`, the pin (found exactly once), the running against the
 * enforced version, and each component's editor tools. Exits 1 when anything failed.
 */
export const doctor: Command = async (argv, io) => {
  const { values } = parse(argv, { json: { type: 'boolean', default: false } });
  const items = await doctorReport({
    cwd: io.cwd,
    env: io.env,
    exec,
    node: { version: process.versions.node, range: requiredNode() },
    running: ownVersion(),
    loadPacks: async () => (await import('../core/registry.js')).PACKS,
  });
  const ok = items.every((i) => i.status !== 'fail');
  if (values.json) {
    io.out(`${JSON.stringify({ schema: 'talos.doctor/1', ok, items })}\n`);
  } else {
    io.out(`${items.map(line).join('\n')}\n`);
  }
  return ok ? 0 : 1;
};
