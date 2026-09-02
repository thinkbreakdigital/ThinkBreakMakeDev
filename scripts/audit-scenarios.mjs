import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { flattenManifestScenarios, loadSidecars, readJson, runGovernanceChecks, tryReadJson, RISK_ORDER } from './validate-governance.mjs';

function daysSince(dateString) {
  const then = new Date(`${dateString}T00:00:00Z`);
  return Math.floor((Date.now() - then.getTime()) / (1000 * 60 * 60 * 24));
}

export function buildRegister({ root = '.' } = {}) {
  const manifestPath = join(root, 'scenarios', 'manifest.json');
  const governancePath = join(root, 'spec', 'governance.json');
  const testsRoot = join(root, 'spec', 'tests');

  const manifest = tryReadJson(manifestPath);
  const governance = tryReadJson(governancePath);
  const manifestScenarios = flattenManifestScenarios(manifest);
  const sidecars = governance ? loadSidecars(join(root, 'spec', 'scenarios'), governance, []) : [];
  const check = governance ? runGovernanceChecks({ root }) : { errors: [], warnings: [], fatal: 'spec/governance.json not found' };

  const sidecarByScenarioId = new Map(sidecars.filter(({ sidecar }) => sidecar.scenarioId != null).map(({ sidecar }) => [sidecar.scenarioId, sidecar]));

  let active = 0;
  let inactive = 0;
  let unknownState = 0;
  for (const scenario of manifestScenarios) {
    const filePath = join(root, scenario.file);
    const pulled = existsSync(filePath) ? tryReadJson(filePath) : null;
    if (!pulled || typeof pulled.isActive !== 'boolean') {
      unknownState += 1;
    } else if (pulled.isActive) {
      active += 1;
    } else {
      inactive += 1;
    }
  }

  const riskCounts = { low: 0, moderate: 0, high: 0, critical: 0 };
  let aiScenarios = 0;
  let customerFacing = 0;
  let missingOwner = 0;
  let missingTests = 0;
  let overdueReview = 0;

  for (const { sidecar } of sidecars) {
    if (RISK_ORDER.includes(sidecar.risk)) riskCounts[sidecar.risk] += 1;
    if (sidecar.ai?.used) aiScenarios += 1;
    if (sidecar.flags?.customerFacing) customerFacing += 1;
    if (!sidecar.owner) missingOwner += 1;

    const tier = governance?.riskTiers?.[sidecar.risk];
    if (tier?.requiresTests && !existsSync(join(testsRoot, sidecar.key, 'cases.json'))) missingTests += 1;
    if (tier?.reviewIntervalDays) {
      if (!sidecar.reviewedOn || daysSince(sidecar.reviewedOn) > tier.reviewIntervalDays) overdueReview += 1;
    }
  }

  const missingSidecar = manifestScenarios.filter((scenario) => !sidecarByScenarioId.has(scenario.id)).length;

  return {
    generatedAt: new Date().toISOString(),
    totalScenarios: manifestScenarios.length,
    active,
    inactive,
    unknownState,
    riskCounts,
    aiScenarios,
    customerFacing,
    missingOwner,
    missingTests,
    missingSidecar,
    overdueReview,
    sidecarCount: sidecars.length,
    check: { errors: check.errors?.length ?? null, warnings: check.warnings?.length ?? null, fatal: check.fatal ?? null },
  };
}

function toMarkdown(register) {
  const lines = [];
  lines.push('# Make automation register');
  lines.push('');
  lines.push(`Generated ${register.generatedAt}. Run \`npm run make:check\` for the full findings behind these counts.`);
  lines.push('');
  lines.push(`- **Scenarios:** ${register.totalScenarios} (${register.active} active, ${register.inactive} inactive, ${register.unknownState} unknown)`);
  lines.push(`- **Sidecars:** ${register.sidecarCount}`);
  lines.push(`- **AI scenarios:** ${register.aiScenarios}`);
  lines.push(`- **Customer-facing:** ${register.customerFacing}`);
  lines.push('');
  lines.push('## Risk');
  lines.push('');
  lines.push('| Tier | Count |');
  lines.push('|---|---|');
  for (const tier of RISK_ORDER) {
    lines.push(`| ${tier} | ${register.riskCounts[tier]} |`);
  }
  lines.push('');
  lines.push('## Gaps');
  lines.push('');
  lines.push(`- **Missing sidecar:** ${register.missingSidecar}`);
  lines.push(`- **Missing owner:** ${register.missingOwner}`);
  lines.push(`- **Missing tests:** ${register.missingTests}`);
  lines.push(`- **Overdue review:** ${register.overdueReview}`);
  lines.push('');
  lines.push('## Governance check');
  lines.push('');
  if (register.check.fatal) {
    lines.push(`Could not run: ${register.check.fatal}`);
  } else {
    lines.push(`${register.check.errors} error(s), ${register.check.warnings} warning(s). Run \`npm run make:check\` for details.`);
  }
  lines.push('');

  return lines.join('\n');
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  const args = new Set(process.argv.slice(2));
  const rootFlag = process.argv.find((arg, index) => process.argv[index - 1] === '--root');
  const root = rootFlag ?? '.';
  const register = buildRegister({ root });
  const markdown = toMarkdown(register);

  if (args.has('--json')) {
    console.log(JSON.stringify(register, null, 2));
  } else {
    console.log(markdown);
  }

  if (root === '.') {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync('reports', { recursive: true });
    writeFileSync('reports/automation-register.md', `${markdown}\n`);
  }
}
