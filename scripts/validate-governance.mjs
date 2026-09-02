import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// This checker never loads .env and never touches process.env for Make
// credentials. It reads only local files, so it runs the same way with or
// without a Make API key configured, including in CI.

const RISK_ORDER = ['low', 'moderate', 'high', 'critical'];
const EXCEPTION_KEYS = ['onUnknownInput', 'onExternalApiFailure', 'onValidationFailure', 'onAIUncertainty'];
const EXCEPTION_ACTIONS = new Set(['stop', 'retry', 'manual-review']);

const MISSING_TESTS_SEVERITY = 'error';

const SECRET_PATTERNS = [
  { rule: 'secret-anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{10,}/ },
  { rule: 'secret-openai-key', pattern: /sk-[A-Za-z0-9]{20,}/ },
  { rule: 'secret-github-token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { rule: 'secret-slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'secret-aws-key-id', pattern: /AKIA[0-9A-Z]{16}/ },
  { rule: 'secret-google-api-key', pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { rule: 'secret-private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'secret-bearer-token', pattern: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  { rule: 'secret-jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: 'secret-url-credentials', pattern: /https?:\/\/[^/\s:@]+:[^/\s:@]+@/ },
];

// Deliberately excludes the bare word "key" - the sidecar schema uses it for
// the scenario slug field, and Make blueprints use it in unrelated UI state.
const SUSPICIOUS_KEY = /api[-_]?key|secret|token|password|passwd|credential|authorization|bearer|private[-_]?key/i;
const SKIPPED_KEYS = new Set(['designer', '__IMTCONN__']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function tryReadJson(path) {
  if (!existsSync(path)) return null;
  return readJson(path);
}

function walkJsonFiles(root, result = []) {
  if (!existsSync(root)) return result;

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) walkJsonFiles(entryPath, result);
    if (entry.isFile() && entry.name.endsWith('.json')) result.push(entryPath);
  }

  return result;
}

function flattenManifestScenarios(manifest) {
  const scenarios = [];
  for (const organization of manifest?.organizations ?? []) {
    for (const team of organization.teams ?? []) {
      for (const scenario of team.scenarios ?? []) {
        scenarios.push(scenario);
      }
    }
  }
  return scenarios;
}

function isPublishedStagedScenario(scenario) {
  return Boolean(scenario.id || scenario.publishedScenarioId);
}

// --- secret scanning -------------------------------------------------

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function isExemptValue(value) {
  if (value.includes('{{') && value.includes('}}')) return true; // Make mapping expression
  if (/^\d+$/.test(value)) return true;
  if (UUID_PATTERN.test(value)) return true;
  if (ISO_DATE_PATTERN.test(value)) return true;
  return false;
}

function fingerprint(value) {
  const prefix = value.slice(0, 4);
  return `${prefix}... (${value.length} chars)`;
}

function scanValue(value, path, key, allowlist, findings) {
  if (isExemptValue(value)) return;

  const hash = createHash('sha256').update(value).digest('hex');
  if (allowlist[hash]) return;

  for (const { rule, pattern } of SECRET_PATTERNS) {
    if (pattern.test(value)) {
      findings.push({ severity: 'error', rule, target: path, message: `Possible secret at ${path}: ${fingerprint(value)}. If reviewed and safe, add its sha256 to spec/secret-scan-allow.json.` });
      return;
    }
  }

  if (key && SUSPICIOUS_KEY.test(key) && value.length >= 16 && shannonEntropy(value) >= 3.5) {
    findings.push({ severity: 'warning', rule: 'secret-heuristic', target: path, message: `High-entropy value under a credential-shaped key at ${path}: ${fingerprint(value)}. If reviewed and safe, add its sha256 to spec/secret-scan-allow.json.` });
  }
}

function scanNode(node, path, key, allowlist, findings) {
  if (key && SKIPPED_KEYS.has(key)) return;

  if (typeof node === 'string') {
    scanValue(node, path, key, allowlist, findings);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => scanNode(item, `${path}[${index}]`, key, allowlist, findings));
    return;
  }
  if (node && typeof node === 'object') {
    const separator = path.endsWith(':') ? '' : '.';
    for (const [childKey, childValue] of Object.entries(node)) {
      scanNode(childValue, `${path}${separator}${childKey}`, childKey, allowlist, findings);
    }
  }
}

function scanFileForSecrets(path, allowlist, findings) {
  let content;
  try {
    content = readJson(path);
  } catch {
    return; // malformed JSON is reported elsewhere; nothing to scan
  }
  scanNode(content, `${path}:`, null, allowlist, findings);
}

// --- sidecar loading and schema validation ----------------------------

function loadSidecars(sidecarsRoot, governance, findings) {
  const sidecars = [];
  if (!existsSync(sidecarsRoot)) return sidecars;

  for (const entry of readdirSync(sidecarsRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('_')) continue;

    const path = join(sidecarsRoot, entry.name);
    const key = entry.name.slice(0, -'.json'.length);
    let sidecar;
    try {
      sidecar = readJson(path);
    } catch (error) {
      findings.push({ severity: 'error', rule: 'sidecar-parse', target: path, message: `${path} could not be parsed: ${error.message}` });
      continue;
    }

    if (sidecar.key !== key) {
      findings.push({ severity: 'error', rule: 'sidecar-key', target: path, message: `${path}: key "${sidecar.key}" does not match the filename "${key}".` });
    }
    if (!RISK_ORDER.includes(sidecar.risk)) {
      findings.push({ severity: 'error', rule: 'sidecar-risk', target: path, message: `${path}: risk "${sidecar.risk}" is not one of ${RISK_ORDER.join(', ')}.` });
      continue;
    }
    if (!Array.isArray(sidecar.data?.classification)) {
      findings.push({ severity: 'error', rule: 'sidecar-data', target: path, message: `${path}: data.classification must be an array.` });
      continue;
    }

    sidecars.push({ path, key, sidecar });
  }

  return sidecars;
}

// --- binding: sidecar <-> scenario ------------------------------------

function checkBindings(sidecars, manifestScenarios, stagedScenarios, governance, findings) {
  const manifestById = new Map(manifestScenarios.map((scenario) => [scenario.id, scenario]));
  const stagedByPath = new Map(stagedScenarios.map(({ relPath, scenario }) => [relPath, scenario]));
  const scenarioIdOwners = new Map();

  for (const { path, key, sidecar } of sidecars) {
    const hasScenarioId = sidecar.scenarioId !== null && sidecar.scenarioId !== undefined;
    const hasStagedFile = Boolean(sidecar.stagedFile);

    if (hasScenarioId) {
      if (scenarioIdOwners.has(sidecar.scenarioId)) {
        findings.push({ severity: 'error', rule: 'sidecar-duplicate-id', target: path, message: `${path} and ${scenarioIdOwners.get(sidecar.scenarioId)} both claim scenarioId ${sidecar.scenarioId}.` });
      } else {
        scenarioIdOwners.set(sidecar.scenarioId, path);
      }
      if (!manifestById.has(sidecar.scenarioId)) {
        findings.push({ severity: 'error', rule: 'sidecar-unbound', target: path, message: `${path} references scenarioId ${sidecar.scenarioId}, which is not in scenarios/manifest.json.` });
      }
      if (hasStagedFile) {
        const staged = stagedByPath.get(sidecar.stagedFile);
        const publishedId = staged?.publishedScenarioId ?? staged?.id;
        if (publishedId && publishedId !== sidecar.scenarioId) {
          findings.push({ severity: 'error', rule: 'sidecar-drift', target: path, message: `${path}: scenarioId ${sidecar.scenarioId} does not match publishedScenarioId ${publishedId} in ${sidecar.stagedFile}.` });
        }
      }
      continue;
    }

    if (hasStagedFile) {
      const staged = stagedByPath.get(sidecar.stagedFile);
      if (!staged) {
        findings.push({ severity: 'error', rule: 'sidecar-unbound', target: path, message: `${path} references stagedFile ${sidecar.stagedFile}, which does not exist.` });
        continue;
      }
      const publishedId = staged.publishedScenarioId ?? staged.id;
      if (publishedId) {
        findings.push({ severity: 'warning', rule: 'sidecar-drift', target: path, message: `${path}: ${sidecar.stagedFile} was already published as scenarioId ${publishedId}. Set scenarioId to ${publishedId} in this sidecar.` });
      }
      continue;
    }

    findings.push({ severity: 'error', rule: 'sidecar-unbound', target: path, message: `${path} has neither scenarioId nor stagedFile set. It does not bind to any scenario.` });
  }

  const boundStagedPaths = new Set(sidecars.map(({ sidecar }) => sidecar.stagedFile).filter(Boolean));

  for (const scenario of manifestScenarios) {
    if (!scenarioIdOwners.has(scenario.id)) {
      findings.push({ severity: governance.enforcement.unclassifiedPulledScenario, rule: 'scenario-ungoverned', target: `scenarios/manifest.json#${scenario.id}`, message: `Scenario ${scenario.id} (${scenario.name}) has no sidecar in spec/scenarios/.` });
    }
  }

  for (const { relPath, scenario } of stagedScenarios) {
    if (isPublishedStagedScenario(scenario)) continue;
    if (!boundStagedPaths.has(relPath)) {
      findings.push({ severity: governance.enforcement.unclassifiedStagedScenario, rule: 'scenario-ungoverned', target: relPath, message: `${relPath} has no sidecar in spec/scenarios/. New scenarios need a sidecar before they can be pushed.` });
    }
  }
}

// --- risk tier requirements and escalation -----------------------------

function daysSince(dateString) {
  const then = new Date(`${dateString}T00:00:00Z`);
  return Math.floor((Date.now() - then.getTime()) / (1000 * 60 * 60 * 24));
}

function riskFloor(sidecar, governance) {
  const triggers = governance.riskTriggers;
  let floorIndex = 0;
  const reasons = [];

  for (const classification of sidecar.data.classification) {
    const tier = triggers.handlesClassifications[classification];
    if (tier && RISK_ORDER.indexOf(tier) > floorIndex) {
      floorIndex = RISK_ORDER.indexOf(tier);
      reasons.push(`data.classification includes "${classification}" (floor: ${tier})`);
    }
  }
  if (sidecar.flags?.writesToExternalSystem && RISK_ORDER.indexOf(triggers.writesToExternalSystem) > floorIndex) {
    floorIndex = RISK_ORDER.indexOf(triggers.writesToExternalSystem);
    reasons.push(`flags.writesToExternalSystem is true (floor: ${triggers.writesToExternalSystem})`);
  }
  if (sidecar.flags?.customerFacing && RISK_ORDER.indexOf(triggers.customerFacing) > floorIndex) {
    floorIndex = RISK_ORDER.indexOf(triggers.customerFacing);
    reasons.push(`flags.customerFacing is true (floor: ${triggers.customerFacing})`);
  }
  if (sidecar.ai?.used && RISK_ORDER.indexOf(triggers.usesGenerativeAI) > floorIndex) {
    floorIndex = RISK_ORDER.indexOf(triggers.usesGenerativeAI);
    reasons.push(`ai.used is true (floor: ${triggers.usesGenerativeAI})`);
  }

  return { tier: RISK_ORDER[floorIndex], reasons };
}

function checkTierRequirements(path, sidecar, governance, testsRoot, findings) {
  const tier = governance.riskTiers[sidecar.risk];

  const floor = riskFloor(sidecar, governance);
  if (RISK_ORDER.indexOf(sidecar.risk) < RISK_ORDER.indexOf(floor.tier)) {
    findings.push({ severity: 'error', rule: 'risk-escalation', target: path, message: `${path}: declared risk "${sidecar.risk}" is below the floor "${floor.tier}" implied by ${floor.reasons.join('; ')}.` });
  }

  if (tier.requiresOwner && !sidecar.owner) {
    findings.push({ severity: 'error', rule: 'sidecar-owner', target: path, message: `${path}: risk "${sidecar.risk}" requires an owner.` });
  }

  if (tier.requiresExceptionPolicy) {
    const missingKeys = EXCEPTION_KEYS.filter((key) => sidecar.exceptions?.[key] === undefined);
    if (missingKeys.length > 0) {
      findings.push({ severity: 'error', rule: 'sidecar-exceptions', target: path, message: `${path}: risk "${sidecar.risk}" requires an exception policy; missing ${missingKeys.join(', ')}.` });
    } else {
      for (const key of EXCEPTION_KEYS) {
        const value = sidecar.exceptions[key];
        const action = typeof value === 'string' ? value : value?.action;
        if (!EXCEPTION_ACTIONS.has(action)) {
          findings.push({ severity: 'error', rule: 'sidecar-exceptions', target: path, message: `${path}: exceptions.${key} has an unrecognized action "${action}". Use one of ${[...EXCEPTION_ACTIONS].join(', ')}.` });
        }
      }
    }
  }

  if (tier.reviewIntervalDays) {
    if (!sidecar.reviewedOn) {
      findings.push({ severity: 'error', rule: 'sidecar-review', target: path, message: `${path}: risk "${sidecar.risk}" requires reviewedOn.` });
    } else {
      const age = daysSince(sidecar.reviewedOn);
      if (age > tier.reviewIntervalDays) {
        findings.push({ severity: 'error', rule: 'sidecar-review-expired', target: path, message: `${path}: last reviewed ${age} days ago, past the ${tier.reviewIntervalDays}-day limit for "${sidecar.risk}".` });
      } else if (age > tier.reviewIntervalDays * 0.8) {
        findings.push({ severity: 'warning', rule: 'sidecar-review-due', target: path, message: `${path}: last reviewed ${age} days ago, approaching the ${tier.reviewIntervalDays}-day limit for "${sidecar.risk}".` });
      }
    }
  }

  if (tier.requiresTests) {
    const casesPath = join(testsRoot, sidecar.key, 'cases.json');
    if (!existsSync(casesPath)) {
      findings.push({ severity: MISSING_TESTS_SEVERITY, rule: 'sidecar-tests', target: path, message: `${path}: risk "${sidecar.risk}" requires tests at ${casesPath}, which does not exist.` });
    }
  }
}

// --- data policy: classification and AI checks -------------------------

function checkDataPolicy(path, sidecar, dataPolicy, findings) {
  const allClassifications = new Set([...sidecar.data.classification, ...(sidecar.ai?.sendsClassifications ?? [])]);
  for (const classification of allClassifications) {
    if (!dataPolicy.classifications[classification]) {
      findings.push({ severity: 'error', rule: 'data-classification-unknown', target: path, message: `${path}: classification "${classification}" is not defined in spec/data-policy.json.` });
    }
  }

  if (sidecar.ai?.used && !sidecar.ai.provider) {
    findings.push({ severity: 'error', rule: 'ai-provider-missing', target: path, message: `${path}: ai.used is true but ai.provider is not set.` });
  }

  for (const classification of sidecar.ai?.sendsClassifications ?? []) {
    const entry = dataPolicy.classifications[classification];
    if (!entry) continue; // already reported above

    if (entry.aiAllowed === false) {
      findings.push({ severity: 'error', rule: 'ai-data-policy', target: path, message: `${path}: classification "${classification}" may not be sent to AI (aiAllowed: false in spec/data-policy.json).` });
    } else if (entry.aiAllowed === 'conditional') {
      const approved = entry.approvedProviders ?? [];
      if (!sidecar.ai?.provider || !approved.includes(sidecar.ai.provider)) {
        findings.push({ severity: 'error', rule: 'ai-data-policy', target: path, message: `${path}: classification "${classification}" only allows AI providers [${approved.join(', ')}], but ai.provider is "${sidecar.ai?.provider ?? 'unset'}".` });
      }
    }
  }
}

// --- UAT case file shape -------------------------------------------------

function checkTestFiles(testsRoot, findings) {
  if (!existsSync(testsRoot)) return;

  for (const entry of readdirSync(testsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const casesPath = join(testsRoot, entry.name, 'cases.json');
    if (!existsSync(casesPath)) continue;

    let cases;
    try {
      cases = readJson(casesPath);
    } catch (error) {
      findings.push({ severity: 'error', rule: 'tests-parse', target: casesPath, message: `${casesPath} could not be parsed: ${error.message}` });
      continue;
    }

    if (cases.scenario !== entry.name) {
      findings.push({ severity: 'error', rule: 'tests-schema', target: casesPath, message: `${casesPath}: scenario "${cases.scenario}" does not match the directory name "${entry.name}".` });
    }
    if (!Array.isArray(cases.cases) || cases.cases.length === 0) {
      findings.push({ severity: 'error', rule: 'tests-schema', target: casesPath, message: `${casesPath}: cases must be a non-empty array.` });
      continue;
    }
    cases.cases.forEach((testCase, index) => {
      if (typeof testCase.name !== 'string' || !testCase.name.trim()) {
        findings.push({ severity: 'error', rule: 'tests-schema', target: casesPath, message: `${casesPath}: cases[${index}] requires a non-empty name.` });
      }
      if (!testCase.input || typeof testCase.input !== 'object') {
        findings.push({ severity: 'error', rule: 'tests-schema', target: casesPath, message: `${casesPath}: cases[${index}] ("${testCase.name}") requires an input object.` });
      }
      if (!testCase.expected || typeof testCase.expected !== 'object') {
        findings.push({ severity: 'error', rule: 'tests-schema', target: casesPath, message: `${casesPath}: cases[${index}] ("${testCase.name}") requires an expected object.` });
      }
    });
  }
}

// --- policy-and-scenario-in-same-change warning -------------------------

function checkPolicyChangedWithScenario(root, governance, findings) {
  let changed;
  try {
    changed = execFileSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    return; // not a git repo, or git unavailable; nothing to check
  }

  const policyChanged = changed.some((file) => file === 'spec/governance.json' || file === 'spec/data-policy.json' || file.startsWith('spec/scenarios/'));
  const scenarioChanged = changed.some((file) => file.startsWith('scenarios/') && file !== 'scenarios/manifest.json');

  if (policyChanged && scenarioChanged) {
    findings.push({
      severity: governance.enforcement.policyAndScenarioInSameChange,
      rule: 'policy-with-scenario',
      target: 'working tree',
      message: 'Policy or sidecar files changed in the same working tree as scenario files. An agent should not be able to change the rule blocking its own scenario change; split the policy change into its own commit for human review.',
    });
  }
}

// --- entry point --------------------------------------------------------

export function runGovernanceChecks({ root = '.' } = {}) {
  const specRoot = join(root, 'spec');
  const scenariosRoot = join(root, 'scenarios');
  const governancePath = join(specRoot, 'governance.json');
  const dataPolicyPath = join(specRoot, 'data-policy.json');
  const sidecarsRoot = join(specRoot, 'scenarios');
  const testsRoot = join(specRoot, 'tests');
  const manifestPath = join(scenariosRoot, 'manifest.json');
  const stagedRoot = join(scenariosRoot, '_new');
  const allowlistPath = join(specRoot, 'secret-scan-allow.json');

  let governance;
  let dataPolicy;
  try {
    governance = readJson(governancePath);
  } catch (error) {
    return { fatal: `${governancePath} could not be read or parsed: ${error.message}`, errors: [], warnings: [] };
  }
  try {
    dataPolicy = readJson(dataPolicyPath);
  } catch (error) {
    return { fatal: `${dataPolicyPath} could not be read or parsed: ${error.message}`, errors: [], warnings: [] };
  }

  const findings = [];
  const sidecars = loadSidecars(sidecarsRoot, governance, findings);
  const manifest = tryReadJson(manifestPath);
  const manifestScenarios = flattenManifestScenarios(manifest);
  const stagedScenarios = walkJsonFiles(stagedRoot).map((path) => ({ path, relPath: relative(root, path), scenario: tryReadJson(path) ?? {} }));

  checkBindings(sidecars, manifestScenarios, stagedScenarios, governance, findings);

  for (const { path, sidecar } of sidecars) {
    if (!RISK_ORDER.includes(sidecar.risk)) continue; // already reported by loadSidecars
    checkTierRequirements(path, sidecar, governance, testsRoot, findings);
    checkDataPolicy(path, sidecar, dataPolicy, findings);
  }

  const allowlist = tryReadJson(allowlistPath) ?? {};
  for (const path of [...walkJsonFiles(stagedRoot), ...walkJsonFiles(scenariosRoot).filter((p) => p !== manifestPath && !p.startsWith(stagedRoot))]) {
    scanFileForSecrets(path, allowlist, findings);
  }
  for (const path of walkJsonFiles(specRoot)) {
    if (path === allowlistPath) continue;
    scanFileForSecrets(path, allowlist, findings);
  }

  checkTestFiles(testsRoot, findings);
  checkPolicyChangedWithScenario(root, governance, findings);

  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  return { fatal: null, errors, warnings, sidecarCount: sidecars.length, manifestScenarioCount: manifestScenarios.length };
}

function printReport(result) {
  if (result.fatal) {
    console.error(`FATAL  ${result.fatal}`);
    return;
  }

  for (const finding of result.errors) {
    console.error(`ERROR  ${finding.rule}  ${relative('.', finding.target)} — ${finding.message}`);
  }
  for (const finding of result.warnings) {
    console.warn(`WARN   ${finding.rule}  ${relative('.', finding.target)} — ${finding.message}`);
  }

  console.log(`\n${result.sidecarCount} sidecar(s), ${result.manifestScenarioCount} scenario(s) in the manifest.`);
  console.log(`${result.errors.length} error(s), ${result.warnings.length} warning(s).`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const args = new Set(process.argv.slice(2));
  const rootFlag = process.argv.find((arg, index) => process.argv[index - 1] === '--root');
  const result = runGovernanceChecks({ root: rootFlag ?? '.' });

  if (args.has('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printReport(result);
  }

  process.exitCode = result.fatal ? 2 : result.errors.length > 0 ? 1 : 0;
}
