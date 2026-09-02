# Make scenario development template

## Intro

Howdy! This is my way of being able to drop a Make section into a client folder and allow agents to work within it.
You can copy this folder into a project, put client information/rules/conventions into /spec/client-rules.md, set your .env variables, and you are ready to modify, back up, and control your Make.com scenarios in your IDE of choice.

## Requirements

- Node.js 20 or newer
- npm
- A Make API key with access to the client organization

## Set up a client project

1. Install the project dependencies:

   ```bash
   npm install
   ```

2. Start the interactive setup:

   ```bash
   npm run make:setup
   ```

3. Select the Make zone with the arrow keys and press Enter.

4. Paste the Make API key. The terminal masks the value.

5. Select the client organization if the key can access more than one organization.

The setup command validates the credentials before it writes them. For a new project, it copies `.env.example` to `.env`, fills in the selected values, and restricts the file permissions. If `.env` already exists, the command asks before it updates the Make values and preserves other variables.

The local `.env` contains:

```dotenv
MAKE_API_KEY="..."
MAKE_ZONE="us1.make.com"
MAKE_ORGANIZATION_ID="123456"
```

Git ignores `.env`. Do not print, commit, or paste its contents into issues, documentation, or chat.

### Secret handling

`.env` holds the Make API key. Git-ignoring it at mode `0600` stops it from being committed and from being read by other operating-system users. It does not hide it from an agent working in this repository. Any command an agent runs is a process on the same machine, under the same operating-system user, and it inherits the same environment.

Because of that, agents in this repository never run the commands that load `.env`: `make:setup`, `make:pull`, `make:push`, `make:sync`, `make:dry-run`, and any direct `make-cli` invocation. See [AGENTS.md](AGENTS.md) for the full rule. Run these commands yourself, in your own terminal, and the agent works from the results. `.claude/settings.json` also requires manual approval before any of these commands run, so an agent cannot run one without you seeing a prompt first.

No script or setting can let an agent run these commands while keeping the key out of its reach. Removing the agent from that step is what actually works.

`make:check` and `make:audit` never load `.env` and never see `MAKE_API_KEY`. They run the same way with or without credentials configured, including in CI with no secrets set up.

## Pull the organization

Pull the current scenarios before editing anything:

```bash
npm run make:pull
```

The command writes scenarios below:

```text
scenarios/<organization-name>--<organization-id>/<team-name>--<team-id>/<folder>/<scenario-name>--<scenario-id>.json
```

Scenarios without a Make folder go in `_unfiled`. `scenarios/manifest.json` records the selected zone, organization, teams, folders, scenarios, and local paths. The ignored `scenarios/.sync-state.json` stores the hashes used for conflict checks.

The pull retains a local file when its remote scenario was deleted. It also refuses to overwrite a local change or a conflicting destination.

## Run synchronization commands

Use the narrowest command that fits the task:

```bash
npm run make:pull
npm run make:push
npm run make:sync
npm run make:dry-run
```

- `make:pull` pulls remote changes without creating scenarios.
- `make:push` creates unpublished definitions from `scenarios/_new/` without pulling first.
- `make:sync` pulls remote changes and then creates unpublished definitions from `scenarios/_new/`.
- `make:dry-run` reports what a full sync would do without writing locally or creating scenarios in Make.

The scripts do not upload edits made to an existing exported scenario. They protect those edits as conflicts. Use the current remote blueprint as the source before you make an approved update through `make-cli`.

The `makesync` script remains as an alias for `make:sync`.

## Create a scenario

Add a JSON definition under `scenarios/_new/`. The definition requires `name`, an integer `teamId`, `scheduling`, and a `blueprint` with a `flow` array. `folderId` is optional.

```json
{
  "name": "Example scenario",
  "teamId": 123,
  "folderId": 456,
  "scheduling": { "type": "indefinitely", "interval": 900 },
  "blueprint": { "flow": [], "metadata": { "version": 1 } }
}
```

Run the dry run first:

```bash
npm run make:dry-run
```

Then create the scenario:

```bash
npm run make:push
```

The command creates the scenario in an inactive state, records `publishedScenarioId` in the staged definition, and saves Make's canonical response in the normal scenario tree. Review the modules, mappings, scheduling, and error handling before activation.

## Record client rules

Add client-specific terminology, systems, restrictions, and requirements to `spec/client-rules.md`. Edit `spec/data-policy.json` directly to change which data classifications exist and which AI providers, if any, each one allows.

## Check governance

Every scenario needs a sidecar at `spec/scenarios/<key>.json` recording its owner, risk tier, data handling, and AI use. See [`spec/scenarios/README.md`](spec/scenarios/README.md) for the field reference, and copy [`spec/scenarios/_template.json`](spec/scenarios/_template.json) to start one.

Run the checker before a push:

```bash
npm run make:check
```

`make:check` reads `spec/governance.json`, `spec/data-policy.json`, and every sidecar, and cross-checks them against `scenarios/manifest.json` and `scenarios/_new/`. It reports risk tier violations, AI data policy violations, missing owners and tests, expired reviews, and possible secrets in scenario JSON. It never loads `.env`, so it runs the same way with or without a Make API key configured. `npm run make:push` runs the same check and refuses to create a scenario if the check reports an error.

A risk tier that requires tests needs case files at `spec/tests/<key>/cases.json`. See [`spec/tests/README.md`](spec/tests/README.md) for the format.

Run the audit for a summary across every scenario:

```bash
npm run make:audit
```

`make:audit` reports scenario counts by risk tier and active state, AI and customer-facing scenario counts, and gaps: missing sidecars, owners, tests, and overdue reviews. It writes `reports/automation-register.md`, which is not committed.