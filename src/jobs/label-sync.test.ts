import { describe, expect, it } from 'vitest';
import { labelPlan, parseLabels, shippedLabels, syncLabels } from './label-sync.js';
import { FakeGitHub } from '../ticket/test/fake-github.js';

describe('parseLabels', () => {
  it('reads the shipped labels, each with a colour and a description GitHub takes', async () => {
    const labels = await shippedLabels();
    expect(labels.length).toBeGreaterThan(20);
    for (const label of labels) {
      expect(label.description.length, label.name).toBeLessThanOrEqual(100);
      expect(label.color).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  it('refuses a name twice, a bad colour, or a long description', () => {
    expect(() =>
      parseLabels(
        '- { name: a, color: "000000", description: x }\n- { name: A, color: "000000", description: y }',
      ),
    ).toThrow(/twice/);
    expect(() => parseLabels('- { name: a, color: "#000000", description: x }')).toThrow();
    expect(() =>
      parseLabels(`- { name: a, color: "000000", description: ${'x'.repeat(101)} }`),
    ).toThrow();
    expect(() => parseLabels('[]')).toThrow();
  });
});

describe('labelPlan', () => {
  const desired = [
    { name: 'bug', color: 'D73A4A', description: 'Type: broken.' },
    { name: 'status/ready', color: '0E8A16', description: 'Ready.' },
    { name: 'legacy', color: 'D4C5F9', description: 'Old.' },
  ];

  it('creates what is missing and updates what differs, deleting nothing', () => {
    const plan = labelPlan(desired, [
      { name: 'Bug', color: 'd73a4a', description: 'Type: broken.' },
      { name: 'status/ready', color: '0e8a16', description: null },
      { name: 'wontfix', color: 'ffffff', description: 'theirs' },
    ]);
    expect(plan.create.map((l) => l.name)).toEqual(['legacy']);
    expect(plan.update.map((l) => [l.current, l.name])).toEqual([
      ['Bug', 'bug'],
      ['status/ready', 'status/ready'],
    ]);
  });

  it('changes nothing when the labels match, colour case aside', () => {
    const existing = desired.map((l) => ({ ...l, color: l.color.toLowerCase() }));
    expect(labelPlan(desired, existing)).toEqual({ create: [], update: [] });
  });
});

describe('syncLabels', () => {
  it('applies the plan', async () => {
    const fake = new FakeGitHub();
    fake.labels.push(
      { name: 'Bug', color: '000000', description: null },
      { name: 'own', color: '111111', description: 'x' },
    );
    const result = await syncLabels(fake.client(), 'o/r', [
      { name: 'bug', color: 'D73A4A', description: 'Type: broken.' },
      { name: 'status/ready', color: '0E8A16', description: 'Ready.' },
    ]);
    expect(result).toEqual({ created: 1, updated: 1 });
    expect(fake.labels).toEqual([
      { name: 'bug', color: 'D73A4A', description: 'Type: broken.' },
      { name: 'own', color: '111111', description: 'x' },
      { name: 'status/ready', color: '0E8A16', description: 'Ready.' },
    ]);
  });
});
