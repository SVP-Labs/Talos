import { escapeXml } from '../../core/xml.js';

export const PHPMD_BASE = 'phpmd.xml';
export const PHPMD_PROJECT = 'phpmd.project.xml';

/** Rules the base sets its own limits on, excluded from their rule set's blanket reference. */
const LIMITS: readonly { rule: string; properties: Readonly<Record<string, string>> }[] = [
  { rule: 'CyclomaticComplexity', properties: { maximum: '12' } },
  { rule: 'ExcessiveParameterList', properties: { maximum: '4' } },
  { rule: 'ExcessiveMethodLength', properties: { maximum: '60', 'ignore-whitespace': 'true' } },
  { rule: 'ExcessiveClassLength', properties: { maximum: '400', 'ignore-whitespace': 'true' } },
];

function limit(entry: (typeof LIMITS)[number]): string[] {
  const properties = Object.entries(entry.properties).map(
    ([name, value]) => `            <property name="${name}" value="${value}"/>`,
  );
  return [
    `    <rule ref="rulesets/codesize.xml/${entry.rule}">`,
    '        <properties>',
    ...properties,
    '        </properties>',
    '    </rule>',
  ];
}

/**
 * The PHPMD ruleset: cleancode, codesize, design, naming and unusedcode in full, codesize's
 * limits set to the standard ones, then the project's extension. PHPMD 3's limits are maxima:
 * it reports a value above `maximum`. `note` is the generated-file note, empty for the gate's copy.
 */
export function renderPhpmd(note: string, project: string | undefined): string {
  const head = note === '' ? [] : [`<!-- ${note} -->`];
  return [
    ...head,
    '<ruleset name="Talos">',
    '    <description>Five PHPMD rule sets in full, at the standard limits.</description>',
    '    <!-- StaticAccess forbids every static call, enum cases and named constructors too. -->',
    '    <rule ref="rulesets/cleancode.xml">',
    '        <exclude name="StaticAccess"/>',
    '    </rule>',
    '    <rule ref="rulesets/codesize.xml">',
    ...LIMITS.map((entry) => `        <exclude name="${entry.rule}"/>`),
    '    </rule>',
    ...LIMITS.flatMap((entry) => limit(entry)),
    '    <rule ref="rulesets/design.xml"/>',
    '    <rule ref="rulesets/naming.xml"/>',
    '    <rule ref="rulesets/unusedcode.xml"/>',
    ...(project === undefined ? [] : [`    <rule ref="${escapeXml(project)}"/>`]),
    '</ruleset>',
    '',
  ].join('\n');
}

/** The extension `talos adopt` writes once: a ruleset of the project's own, empty to start. */
export function initialPhpmdProject(): string {
  return [
    `<!-- This project's additions to ${PHPMD_BASE}, which may only tighten it. -->`,
    '<ruleset name="Project">',
    '    <description>Rules this project adds to the Talos base.</description>',
    '</ruleset>',
    '',
  ].join('\n');
}
