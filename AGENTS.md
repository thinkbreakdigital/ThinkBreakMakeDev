# AGENTS.md

## Project context

This repository stores and changes scenarios for one Make organization. The local `.env` identifies that organization with `MAKE_ZONE` and `MAKE_ORGANIZATION_ID`.

Read the relevant files under `spec/` before you make meaningful changes. Use `spec/client-rules.md` for client-specific rules, context, terminology, systems, and requirements. Update the relevant spec in the same task when behavior, scope, architecture, configuration, or workflow requirements change.

## Make scenario work

Run `npm run make:setup` before the first pull. The setup command stores the Make API key, zone, and organization ID in the ignored `.env` file. Do not commit, print, or expose credentials.

Use the npm scripts documented in `README.md` to pull, inspect, create, and reconcile scenarios. The scripts load `.env` themselves. If you run `make-cli` directly, load `.env` into that terminal first:

```bash
set -a
. ./.env
set +a
```

Inspect the current exported blueprint before proposing or making a workflow change. Modify the exported blueprint instead of giving manual UI steps unless the user asks for instructions.

Preserve working module mappings, connections, variables, routes, and filters unless the task requires a change. Do not invent Make module fields or external API properties. Check current documentation and repository payloads before you use an unfamiliar endpoint, field, or module option.

Validate external input at the boundary. Handle null, empty, malformed, and unexpected values explicitly. Paginate API results, handle rate limits and retries, and make external writes safe to retry where possible.

Add error handlers around recoverable external operations. Do not swallow errors. Log enough context to identify the affected scenario, record, and operation without exposing secrets.

Keep new scenarios inactive until their modules, mappings, schedules, connections, and error paths have been reviewed and tested. Validate exported blueprint JSON after each change.

## Make platform rules

- Reference a field only from a module earlier in the same flow. A later module cannot supply a value to an earlier one, even inside a repeated loop, even if the later module already ran in a previous cycle.
- To carry a value such as a pagination cursor across Repeater or Iterator cycles within one execution, use two `util:SetVariable2` modules with the same `name` and `scope`. Place an initializer before the loop and an updater after the value is computed inside the loop. Point readers at the initializer, since it sits earlier in the flow. Never point a reader at the updater.
- Do not invent a Make module identifier or its parameter shape. A wrong shape can still pass `scenarios create` or `scenarios update` and fail only at runtime. Confirm the shape first. Check an existing scenario in the repo, or check Make's own skills reference (`integromat/make-skills` on GitHub). If neither has the module, ask the user to add an empty instance of it in the Make UI, save it, and read the real exported shape.

## Implementation style

Read target files and nearby usage before editing. Reuse existing functions and patterns. Make the smallest correct change and avoid unrelated refactors.

Prefer clear, inspectable automation. State assumptions only when they affect correctness. Verify changed behavior with the narrowest useful check. If verification cannot run, state what remains unverified.

Never rename, move, or delete files unless the user requests it. Never hardcode secrets, credentials, tokens, account-specific IDs, or environment-specific values in shared code or documentation.
