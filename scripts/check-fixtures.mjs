import assert from 'node:assert/strict';
import { runGovernanceChecks } from './validate-governance.mjs';

const EXPECTED_BAD_RULES = [
  'sidecar-unbound',
  'scenario-ungoverned',
  'risk-escalation',
  'sidecar-owner',
  'sidecar-review-expired',
  'ai-data-policy',
  'secret-anthropic-key',
];

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error.message);
    process.exitCode = 1;
  }
}

test('fixtures/good passes with no errors or warnings', () => {
  const result = runGovernanceChecks({ root: 'fixtures/good' });
  assert.equal(result.fatal, null);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test('fixtures/bad fails with exactly the planted violations', () => {
  const result = runGovernanceChecks({ root: 'fixtures/bad' });
  assert.equal(result.fatal, null);
  const foundRules = new Set(result.errors.map((finding) => finding.rule));
  for (const rule of EXPECTED_BAD_RULES) {
    assert.ok(foundRules.has(rule), `expected rule "${rule}" to be reported, found: ${[...foundRules].join(', ')}`);
  }
  // ai-data-policy is planted twice (credentials + unapproved provider for customer-pii)
  const aiFindings = result.errors.filter((finding) => finding.rule === 'ai-data-policy');
  assert.equal(aiFindings.length, 2, `expected 2 ai-data-policy findings, got ${aiFindings.length}`);
});

test('a malformed spec/governance.json is fatal, not a silent pass', () => {
  const result = runGovernanceChecks({ root: 'fixtures/malformed-governance' });
  assert.ok(result.fatal, 'expected a fatal error for malformed governance.json');
});

test('the real repo root passes with no scenarios pulled yet', () => {
  const result = runGovernanceChecks({ root: '.' });
  assert.equal(result.fatal, null);
  assert.deepEqual(result.errors, []);
});
