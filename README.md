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

Git-ignoring `.env` and setting it to mode `0600` stops the key from being committed, from appearing in scenario JSON, and from being read by other operating-system users. It does not stop an agent working in this project from reading it. Any process with shell or filesystem access here can run `cat .env`. The same values sit in `process.env` for every `npm run make:*` command. Call this **standard mode**: it fits solo development on a client project, and it is not a barrier against the tools working in the repo.

A **protected mode** is on the roadmap, not built yet. The repo would store only a secret reference, such as `MAKE_API_KEY_SECRET=thinkbreak/client-a/make-api`, and a resolver would fetch the real value from an OS keyring, 1Password CLI, `pass`, or Bitwarden CLI when a command runs. That narrows exposure from "always present in the environment" to "present for the duration of one command," and it adds an audit trail on the vault side. It does not remove the limit above: an agent that can run the resolver can still read the secret the resolver returns.

The governance layer below holds one property today: `make:check` and `make:audit` never load `.env` and never see `MAKE_API_KEY`. They run the same way with or without credentials configured, including in CI with no secrets set up.

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

Add client-specific terminology, systems, restrictions, and requirements to `spec/client-rules.md`.