import { readFileSync } from 'node:fs';
import { it } from 'vitest';
import { holdUvADay, migratePyproject } from './python.js';

it('lorelock', () => {
  const text = readFileSync('/home/user/lorelock/pyproject.toml', 'utf8');
  const m = migratePyproject(text, { ruff: false, pyright: false });
  console.log(m.manual);
  console.log(m.text);
  console.log(m.seeds.get('ruff.toml')?.('# init\nextend = "ruff.talos.toml"\n'));
  console.log(holdUvADay(m.text ?? text).text?.slice(-200));
});
