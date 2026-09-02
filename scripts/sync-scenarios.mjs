import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runGovernanceChecks } from './validate-governance.mjs';

const outputRoot = 'scenarios';
const statePath = join(outputRoot, '.sync-state.json');
const manifestPath = join(outputRoot, 'manifest.json');
const stagedRoot = join(outputRoot, '_new');
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(['--dry-run', '--pull-only', '--push-only']);
const unknownArgs = [...args].filter((argument) => !allowedArgs.has(argument));
const dryRun = args.has('--dry-run');
const pullEnabled = !args.has('--push-only');
const pushEnabled = !args.has('--pull-only');

if (unknownArgs.length > 0) {
  throw new Error(`Unknown argument${unknownArgs.length === 1 ? '' : 's'}: ${unknownArgs.join(', ')}`);
}
if (args.has('--push-only') && args.has('--pull-only')) {
  throw new Error('Use at most one of --push-only and --pull-only.');
}

for (const variable of ['MAKE_API_KEY', 'MAKE_ZONE', 'MAKE_ORGANIZATION_ID']) {
  if (!process.env[variable]) {
    throw new Error(`${variable} is required. Load .env before syncing.`);
  }
}

const organizationId = Number(process.env.MAKE_ORGANIZATION_ID);
if (!Number.isInteger(organizationId) || organizationId <= 0) {
  throw new Error('MAKE_ORGANIZATION_ID must be a positive integer.');
}

function make(...makeArgs) {
  return JSON.parse(execFileSync('make-cli', [...makeArgs, '--output', 'json'], {
    encoding: 'utf8',
    env: process.env,
  }));
}

function safeName(value) {
  const name = String(value)
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return name || 'unnamed';
}

function localName(name, id) {
  return `${safeName(name)}--${id}`;
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function collectFolders(folders, prefix = '', result = new Map()) {
  for (const folder of folders) {
    const folderPath = prefix ? `${prefix}/${folder.name}` : folder.name;
    result.set(folder.id, folderPath);
    collectFolders(folder.children ?? [], folderPath, result);
  }

  return result;
}

function localFolderPath(folderPath, foldersById, folderId) {
  const makePath = folderPath ?? foldersById.get(folderId);
  if (!makePath) return '_unfiled';

  return makePath.split('/').filter(Boolean).map(safeName).join('/');
}

function localScenarioPath(teamPath, foldersById, scenario) {
  return join(
    teamPath,
    localFolderPath(scenario.folderPath, foldersById, scenario.folderId),
    `${localName(scenario.name, scenario.id)}.json`,
  );
}

function readState() {
  if (!existsSync(statePath)) {
    return {
      version: 2,
      zone: process.env.MAKE_ZONE,
      organizationId,
      scenarios: {},
    };
  }

  const state = readJson(statePath);
  if (state.version !== 2 || typeof state.scenarios !== 'object' || state.scenarios === null) {
    throw new Error(`${statePath} has an unsupported format.`);
  }
  if (state.zone !== process.env.MAKE_ZONE || state.organizationId !== organizationId) {
    throw new Error(`${statePath} belongs to another Make zone or organization.`);
  }

  return state;
}

function writeState(state) {
  if (!dryRun) writeJson(statePath, state);
}

function fileHash(path) {
  return existsSync(path) ? hash(readFileSync(path)) : null;
}

function stagedFiles(path = stagedRoot, result = []) {
  if (!existsSync(path)) return result;

  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) stagedFiles(entryPath, result);
    if (entry.isFile() && entry.name.endsWith('.json')) result.push(entryPath);
  }

  return result;
}

function validateStagedScenario(path, scenario) {
  if (scenario.id || scenario.publishedScenarioId) return false;
  if (!Number.isInteger(scenario.teamId)) {
    throw new Error(`${path} requires an integer teamId.`);
  }
  if (scenario.folderId !== undefined && !Number.isInteger(scenario.folderId)) {
    throw new Error(`${path} folderId must be an integer when provided.`);
  }
  if (typeof scenario.name !== 'string' || !scenario.name.trim()) {
    throw new Error(`${path} requires a non-empty name.`);
  }
  if (!scenario.scheduling || typeof scenario.scheduling !== 'object') {
    throw new Error(`${path} requires a scheduling object.`);
  }
  if (!scenario.blueprint || typeof scenario.blueprint !== 'object' || Array.isArray(scenario.blueprint)) {
    throw new Error(`${path} requires a blueprint object.`);
  }
  if (!Array.isArray(scenario.blueprint.flow)) {
    throw new Error(`${path} blueprint.flow must be an array.`);
  }

  return true;
}

function collectRemoteScenarios() {
  const scenariosById = new Map();
  const teamsById = new Map();
  const organization = make('organizations', 'list').find((item) => Number(item.id) === organizationId);
  if (!organization) {
    throw new Error(`Make organization ${organizationId} is not accessible with the configured API key.`);
  }

  const teams = organization.teams ?? make('teams', 'list', `--organization-id=${organization.id}`);
  const organizationManifest = { id: organization.id, name: organization.name, teams: [] };

  for (const team of teams) {
    const folders = make('folders', 'list', `--team-id=${team.id}`);
    const foldersById = collectFolders(folders);
    const teamPath = join(outputRoot, localName(organization.name, organization.id), localName(team.name, team.id));
    const context = { foldersById, team, teamPath };
    const scenarios = make('scenarios', 'list', `--team-id=${team.id}`);
    teamsById.set(team.id, context);

    for (const scenario of scenarios) {
      scenariosById.set(scenario.id, { ...context, scenario });
    }

    organizationManifest.teams.push({
      id: team.id,
      name: team.name,
      folders: folders.map(({ id, name, path, parentId }) => ({ id, name, path, parentId })),
      scenarios: scenarios.map((scenario) => ({
        id: scenario.id,
        name: scenario.name,
        folderId: scenario.folderId,
        folderPath: scenario.folderPath,
        file: localScenarioPath(teamPath, foldersById, scenario),
      })),
    });
  }

  return {
    scenariosById,
    teamsById,
    manifest: {
      zone: process.env.MAKE_ZONE,
      organizationId,
      organizations: [organizationManifest],
    },
  };
}

function writeManifest(remote) {
  if (!dryRun) writeJson(manifestPath, remote.manifest);
}

function fetchScenario(id) {
  return make('scenarios', 'get', `--scenario-id=${id}`);
}

function saveRemoteScenario(state, context, remoteScenario) {
  const targetPath = localScenarioPath(context.teamPath, context.foldersById, remoteScenario);
  const content = `${JSON.stringify(remoteScenario, null, 2)}\n`;

  if (!dryRun) {
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, content);
  }

  state.scenarios[remoteScenario.id] = {
    file: targetPath,
    lastEdit: remoteScenario.lastEdit ?? remoteScenario.updated,
    localHash: hash(content),
  };

  return targetPath;
}

function pullRemoteScenarios(state, remote) {
  let pulled = 0;
  let conflicts = 0;

  for (const [id, context] of remote.scenariosById) {
    const tracked = state.scenarios[id];
    const targetPath = localScenarioPath(context.teamPath, context.foldersById, context.scenario);
    const trackedPath = tracked?.file ?? targetPath;
    const localHash = fileHash(trackedPath);
    const remoteLastEdit = context.scenario.lastEdit ?? context.scenario.updated;
    const remoteChanged = !tracked || tracked.lastEdit !== remoteLastEdit;
    const pathChanged = Boolean(tracked && trackedPath !== targetPath);
    const localChanged = Boolean(tracked && localHash !== tracked.localHash);

    if (localChanged) {
      console.error(`Conflict: ${trackedPath} changed locally. It was not overwritten.`);
      conflicts += 1;
      continue;
    }

    if (!remoteChanged && !pathChanged) continue;

    const remoteScenario = fetchScenario(id);
    const canonical = `${JSON.stringify(remoteScenario, null, 2)}\n`;
    if (!tracked && existsSync(targetPath) && hash(readFileSync(targetPath)) !== hash(canonical)) {
      console.error(`Conflict: ${targetPath} differs from Make and has no sync baseline. It was not overwritten.`);
      conflicts += 1;
      continue;
    }
    if (tracked && pathChanged && existsSync(targetPath) && fileHash(targetPath) !== hash(canonical)) {
      console.error(`Conflict: ${targetPath} already exists and differs from Make. The old file was retained.`);
      conflicts += 1;
      continue;
    }

    const savedPath = saveRemoteScenario(state, context, remoteScenario);
    console.log(`${dryRun ? 'Would pull' : 'Pulled'} ${id} to ${savedPath}`);
    if (tracked && trackedPath !== savedPath && existsSync(trackedPath)) {
      if (dryRun) {
        console.log(`Would remove moved scenario file ${trackedPath}`);
      } else if (fileHash(savedPath) === hash(canonical)) {
        unlinkSync(trackedPath);
        console.log(`Removed moved scenario file ${trackedPath}`);
      } else {
        throw new Error(`Refusing to remove ${trackedPath}: ${savedPath} does not match Make's response.`);
      }
    }
    pulled += 1;
  }

  const remoteIds = new Set(remote.scenariosById.keys());
  for (const [id, tracked] of Object.entries(state.scenarios)) {
    if (!remoteIds.has(Number(id))) {
      console.warn(`Remote scenario ${id} no longer exists. Local file retained: ${tracked.file}`);
    }
  }

  return { conflicts, pulled };
}

function pushStagedScenarios(state, remote) {
  let created = 0;

  for (const path of stagedFiles()) {
    const staged = readJson(path);
    if (!validateStagedScenario(path, staged)) continue;

    const team = remote.teamsById.get(staged.teamId);
    if (!team) throw new Error(`${path} refers to teamId ${staged.teamId}, which is not accessible.`);

    const blueprint = { ...staged.blueprint, name: staged.blueprint.name ?? staged.name };
    if (dryRun) {
      console.log(`Would create ${staged.name} from ${path}`);
      created += 1;
      continue;
    }

    const createdScenario = make(
      'scenarios',
      'create',
      `--team-id=${staged.teamId}`,
      ...(staged.folderId === undefined ? [] : [`--folder-id=${staged.folderId}`]),
      `--scheduling=${JSON.stringify(staged.scheduling)}`,
      `--blueprint=${JSON.stringify(blueprint)}`,
      '--confirmed',
    );
    const createdId = createdScenario.id ?? createdScenario.scenarioId ?? createdScenario.scenario_id;
    if (!createdId) {
      throw new Error(`Make did not return an ID after creating ${staged.name}.`);
    }

    const remoteScenario = fetchScenario(createdId);
    const savedPath = saveRemoteScenario(state, team, remoteScenario);
    writeJson(path, { ...staged, publishedScenarioId: remoteScenario.id });
    console.log(`Created inactive scenario ${remoteScenario.id} and exported it to ${savedPath}`);
    created += 1;
  }

  return created;
}

function governanceAllowsPush() {
  const result = runGovernanceChecks({ root: '.' });

  if (result.fatal) {
    console.error(`Governance check could not run: ${result.fatal}`);
    return false;
  }
  if (result.errors.length > 0) {
    console.error(`Governance check found ${result.errors.length} error(s). Push refused. Run npm run make:check for the full report.`);
    for (const finding of result.errors) {
      console.error(`  ${finding.rule}  ${finding.target} — ${finding.message}`);
    }
    return false;
  }

  return true;
}

const state = readState();
let remote = collectRemoteScenarios();
let conflicts = 0;
let created = 0;

if (pullEnabled) {
  ({ conflicts } = pullRemoteScenarios(state, remote));
}

if (conflicts > 0) {
  process.exitCode = 1;
} else if (pushEnabled && governanceAllowsPush()) {
  created = pushStagedScenarios(state, remote);
} else if (pushEnabled) {
  process.exitCode = 1;
}

if (created > 0 && !dryRun) remote = collectRemoteScenarios();
writeManifest(remote);
writeState(state);
