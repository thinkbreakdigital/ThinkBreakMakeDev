# Scenario sidecars

A sidecar is one JSON file per governed scenario, at `spec/scenarios/<key>.json`. It records the scenario's owner, risk tier, data handling, and AI use. `scripts/validate-governance.mjs` checks every sidecar against `spec/governance.json` and `spec/data-policy.json`.

Copy [`_template.json`](_template.json) to start a new sidecar. Filenames starting with `_` are not sidecars; the checker skips them.

## Binding a sidecar to a scenario

A sidecar binds to exactly one of these:

- **A published scenario.** Set `scenarioId` to the scenario's Make ID. The checker looks up that ID in `scenarios/manifest.json`.
- **A staged scenario.** Set `scenarioId` to `null` and `stagedFile` to the path under `scenarios/_new/`. Use this before the scenario exists in Make.

When `npm run make:push` creates a scenario from a staged file, it writes `publishedScenarioId` into that file. Update the sidecar's `scenarioId` to match, and update `stagedFile` to `null` if you no longer need the staged path for history.

## Fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | Sidecar schema version. Currently `1`. |
| `key` | string | yes | Matches the filename without `.json`. Stable across scenario renames. |
| `scenarioId` | integer or `null` | yes | The scenario's Make ID, or `null` before publish. |
| `stagedFile` | string or `null` | when unpublished | Path under `scenarios/_new/` for a scenario not yet created in Make. |
| `owner` | string | by risk tier | The person accountable for this scenario. An email address or a name. |
| `risk` | string | yes | One of `low`, `moderate`, `high`, `critical`. See [`spec/governance.json`](../governance.json) for what each tier requires. |
| `reviewedOn` | date (`YYYY-MM-DD`) | by risk tier | The date of the most recent review. The checker fails a review older than the tier's `reviewIntervalDays`. |
| `data.classification` | array of strings | yes | Data classifications this scenario touches. Each must exist in [`spec/data-policy.json`](../data-policy.json). |
| `ai.used` | boolean | yes | Whether this scenario calls an AI provider. |
| `ai.provider` | string or `null` | when `ai.used` is `true` | The AI provider, matched against `approvedProviders` in the data policy. |
| `ai.purpose` | string or `null` | no | A short description of what the AI call does. |
| `ai.sendsClassifications` | array of strings | when `ai.used` is `true` | Which of `data.classification` this scenario sends to the AI provider. Checked against `aiAllowed` for each classification. |
| `flags.customerFacing` | boolean | yes | Whether this scenario's output reaches a customer directly. |
| `flags.writesToExternalSystem` | boolean | yes | Whether this scenario writes to a system outside Make. |
| `exceptions` | object | by risk tier | See below. |

## The `exceptions` object

Four keys, each declaring what happens when something goes wrong:

| Key | Meaning |
|---|---|
| `onUnknownInput` | What happens when input doesn't match the expected shape. |
| `onExternalApiFailure` | What happens when a call to an external API fails. Takes the form `{ "action": "retry", "attempts": <n> }` or a bare action string. |
| `onValidationFailure` | What happens when a validation check fails. |
| `onAIUncertainty` | What happens when an AI response is ambiguous or low-confidence. |

Each action is one of `stop`, `retry`, or `manual-review`.

## Risk and the data policy

`spec/governance.json` defines `riskTriggers`: a scenario that handles `payment` or `health` data, for example, has a risk floor of `critical` regardless of its declared `risk`. The checker fails a sidecar whose declared `risk` is below the floor its own `data.classification` and `flags` imply.

`spec/data-policy.json` defines whether a classification may go to an AI provider at all (`aiAllowed: true`), never (`aiAllowed: false`), or only to an approved provider (`aiAllowed: "conditional"` with an `approvedProviders` list). The checker fails a sidecar that sends a classification to AI in violation of that policy.
