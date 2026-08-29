import { confirm, input, password, select } from '@inquirer/prompts';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const environmentTemplatePath = resolve('.env.example');
const environmentPath = resolve('.env');

const zoneChoices = [
  { name: 'EU1 - Europe', value: 'eu1.make.com' },
  { name: 'EU2 - Europe', value: 'eu2.make.com' },
  { name: 'US1 - United States', value: 'us1.make.com' },
  { name: 'US2 - United States', value: 'us2.make.com' },
  { name: 'Other or private instance', value: 'custom' },
];

function normalizeZone(value) {
  return value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function validateZone(value) {
  const zone = normalizeZone(value);
  if (!zone) return 'Enter a Make zone.';
  if (!/^[a-z0-9.-]+(?::\d+)?$/.test(zone)) {
    return 'Enter a hostname such as eu1.make.com without a path.';
  }

  return true;
}

function make(environment, ...args) {
  try {
    const output = execFileSync('make-cli', [...args, '--output', 'json'], {
      encoding: 'utf8',
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('make-cli is unavailable. Run npm install and try again.');
    }

    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(detail || 'Make CLI command failed.');
  }
}

function setEnvironmentValue(content, name, value) {
  const line = `${name}=${JSON.stringify(String(value))}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');

  if (pattern.test(content)) {
    return content.replace(pattern, () => line);
  }

  return `${content.trimEnd()}\n${line}\n`;
}

async function setup() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Run npm run make:setup in an interactive terminal.');
  }
  if (!existsSync(environmentTemplatePath)) {
    throw new Error('.env.example is missing. Restore it before setup.');
  }

  const environmentExists = existsSync(environmentPath);
  if (environmentExists) {
    const approved = await confirm({
      message: '.env already exists. Update its Make credentials?',
      default: false,
    });
    if (!approved) {
      process.stdout.write('Setup canceled. .env was not changed.\n');
      return;
    }
  }

  let zone = await select({
    message: 'Select the Make zone:',
    choices: zoneChoices,
    loop: false,
  });
  if (zone === 'custom') {
    zone = normalizeZone(await input({
      message: 'Enter the Make zone:',
      validate: validateZone,
    }));
  }

  const apiKey = (await password({
    message: 'Paste the Make API key:',
    mask: '*',
    toggleMask: false,
    validate: (value) => value.trim() ? true : 'Enter a Make API key.',
  })).trim();

  process.stdout.write('Validating the Make credentials...\n');
  const makeEnvironment = {
    ...process.env,
    MAKE_API_KEY: apiKey,
    MAKE_ZONE: zone,
  };
  make(makeEnvironment, 'whoami');
  const organizations = make(makeEnvironment, 'organizations', 'list');
  if (!Array.isArray(organizations) || organizations.length === 0) {
    throw new Error('The Make API key cannot access an organization.');
  }

  const selectedOrganizationId = organizations.length === 1
    ? organizations[0].id
    : await select({
        message: 'Select the client organization:',
        choices: organizations.map((organization) => ({
          name: organization.name,
          value: organization.id,
          description: `Organization ID ${organization.id}`,
        })),
        loop: false,
      });
  const organizationId = Number(selectedOrganizationId);
  if (!Number.isInteger(organizationId) || organizationId <= 0) {
    throw new Error('Make returned an invalid organization ID.');
  }
  const organization = organizations.find((item) => Number(item.id) === organizationId);

  if (!environmentExists) {
    copyFileSync(environmentTemplatePath, environmentPath);
  }
  chmodSync(environmentPath, 0o600);

  let content = readFileSync(environmentPath, 'utf8');
  content = setEnvironmentValue(content, 'MAKE_API_KEY', apiKey);
  content = setEnvironmentValue(content, 'MAKE_ZONE', zone);
  content = setEnvironmentValue(content, 'MAKE_ORGANIZATION_ID', organizationId);
  writeFileSync(environmentPath, content, { encoding: 'utf8', mode: 0o600 });

  process.stdout.write(`Connected to ${organization.name} (${organization.id}) in ${zone}.\n`);
  process.stdout.write('Run npm run make:pull to export the organization.\n');
}

setup().catch((error) => {
  if (error?.name === 'ExitPromptError') {
    process.stderr.write('Setup canceled.\n');
  } else {
    process.stderr.write(`Setup failed: ${error.message}\n`);
  }
  process.exitCode = 1;
});
