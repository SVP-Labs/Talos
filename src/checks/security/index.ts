import { dependenciesCheck } from './dependencies.js';
import { gitleaksBase } from './gitleaks-config.js';
import { osvConfig } from './osv-config.js';
import { secretsCheck } from './secrets.js';
import { semgrepCheck, semgrepignore } from './semgrep.js';
import { strengthCheck } from './strength.js';
import type { Pack } from '../../core/pack.js';

export const securityPack: Pack = {
  name: 'security',
  checks: [secretsCheck(), dependenciesCheck(), semgrepCheck(), strengthCheck()],
  generated: [gitleaksBase, osvConfig, semgrepignore],
};
