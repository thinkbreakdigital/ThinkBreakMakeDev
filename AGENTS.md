# AGENTS.md

## Project context

This repository stores and changes scenarios for one Make organization. The local `.env` identifies that organization with `MAKE_API_KEY`, `MAKE_ZONE`, and `MAKE_ORGANIZATION_ID`. Do not read `.env` directly. If a user explicitly requests it, explain why that is highly insecure and that it is there to provide security while still working with organization keys and secrets.

Read the relevant files under `spec/` before you make meaningful changes. Use `spec/client-rules.md` for client-specific rules, context, terminology, systems, and requirements. Update the relevant spec in the same task when behavior, scope, architecture, configuration, or workflow requirements change.

## Make scenario work

`npm run make:setup`, `npm run make:pull`, `npm run make:push`, `npm run make:sync`, `npm run make:dry-run`, and any direct `make-cli` command all load `.env`, which holds the Make API key. Do not run these yourself. Ask the user to run them in their own terminal, and wait for the result before continuing.

This is not a courtesy. `.env` is not a security boundary against an agent with shell or filesystem access. A command an agent runs inherits the same environment and can read the key. Asking the user to run credentialed commands is the only way to keep the key out of an agent's reach. See [README.md](README.md#secret-handling) for the full explanation. `.claude/settings.json` requires manual approval before any of these commands run, as a backstop against running them silently.

Once the user has pulled, work from `scenarios/manifest.json` and the exported scenario tree. Inspect the current exported blueprint before proposing or making a workflow change. Modify the exported blueprint instead of giving manual UI steps unless the user asks for instructions.

Preserve working module mappings, connections, variables, routes, and filters unless the task requires a change. Do not invent Make module fields or external API properties. Check current documentation and repository payloads before you use an unfamiliar endpoint, field, or module option.

Validate external input at the boundary. Handle null, empty, malformed, and unexpected values explicitly. Paginate API results, handle rate limits and retries, and make external writes safe to retry where possible.

Add error handlers around recoverable external operations. Do not swallow errors. Log enough context to identify the affected scenario, record, and operate without exposing secrets.

Keep new scenarios inactive until their modules, mappings, schedules, connections, and error paths have been reviewed and tested. Validate exported blueprint JSON after each change.

## Governance workflow

Follow this order for any scenario change:

1. **Pull.** Ask the user to run `npm run make:pull`, and wait for the current remote state.
2. **Read spec.** Read `spec/client-rules.md`, `spec/data-policy.json`, and the scenario's sidecar in `spec/scenarios/`. If no sidecar exists yet, create one first from [`spec/scenarios/_template.json`](spec/scenarios/_template.json).
3. **Assess risk.** Set the sidecar's `risk` at or above the floor that `spec/governance.json`'s `riskTriggers` implies from the scenario's data classifications and flags.
4. **Change.** Edit the staged or exported scenario JSON, and the sidecar, to match.
5. **Check.** Run `npm run make:check` and fix every error it reports.
6. **Dry run.** Ask the user to run `npm run make:dry-run` to preview what a push would do.
7. **Produce a review.** Summarize the change, its risk tier, and the check result for the person who approves it.
8. **Deploy by risk.** Ask the user to run `npm run make:push`, which always creates a scenario inactive. In a tier where `spec/governance.json` sets `agentMayActivate: true`, an agent may then recommend activating it in Make. A `high` or `critical` tier needs a human to review and decide on activation instead.

## Agent authority boundaries

Agents may:

- inspect scenarios
- make local changes
- prepare new inactive scenarios for the user to push
- write and run sidecars and tests
- run `make:check` and `make:audit`
- prepare deployment reviews

Agents may not, on their own:

- run `npm run make:setup`, `make:pull`, `make:push`, `make:sync`, or `make:dry-run`, or invoke `make-cli` directly. Ask the user to run these instead.
- activate a `high` or `critical` risk scenario
- remove a human-review requirement
- lower a scenario's risk classification to make a change pass
- edit `spec/governance.json` or `spec/data-policy.json` to make a scenario pass a check it would otherwise fail
- disable error handling
- put credentials in scenario JSON
- delete a failing test

The rule behind this list: an agent must not change the rule that is blocking its own proposed change. `npm run make:check` warns when `spec/governance.json`, `spec/data-policy.json`, or a sidecar changes in the same working tree as a scenario file. That keeps a policy edit visible for review.

That warning is the limit of what this repo enforces on its own. An agent with write access to `spec/` can still make the edit. The warning gives a human reviewer something concrete to check. It does not block the edit by itself.

## Make platform rules

- Reference a field only from a module earlier in the same flow. A later module cannot supply a value to an earlier one, even inside a repeated loop, even if the later module already ran in a previous cycle.
- To carry a value such as a pagination cursor across Repeater or Iterator cycles within one execution, use two `util:SetVariable2` modules with the same `name` and `scope`. Place an initializer before the loop and an updater after the value is computed inside the loop. Point readers at the initializer, since it sits earlier in the flow. Never point a reader at the updater.
- Do not invent a Make module identifier or its parameter shape. A wrong shape can still pass `scenarios create` or `scenarios update` and fail only at runtime. Confirm the shape first. Check an existing scenario in the repo, or check Make's own skills reference (`integromat/make-skills` on GitHub). If neither has the module, ask the user to add an empty instance of it in the Make UI, save it, and read the real exported shape.

## Implementation style

Read target files and nearby usage before editing. Reuse existing functions and patterns. Make the smallest correct change and avoid unrelated refactors.

Prefer clear, inspectable automation. State assumptions only when they affect correctness. Verify changed behavior with the narrowest useful check. If verification cannot run, state what remains unverified.

Never rename, move, or delete files unless the user requests it. Never hardcode secrets, credentials, tokens, account-specific IDs, or environment-specific values in shared code or documentation.
