# UAT fixtures

Each scenario with a risk tier that sets `requiresTests: true` in [`spec/governance.json`](../governance.json) needs a case file at `spec/tests/<key>/cases.json`, where `<key>` matches the sidecar's `key` field. `scripts/validate-governance.mjs` checks that the file exists and that its shape is valid. It does not execute the cases against a live scenario; that needs a run harness this repo does not yet have.

## File shape

```json
{
  "version": 1,
  "scenario": "invoice-dunning-reminders",
  "cases": [
    {
      "name": "overdue-30-days",
      "input": { "invoiceId": "INV-1001", "daysOverdue": 30, "amount": 450.0 },
      "expected": { "action": "send-reminder", "template": "first-notice" }
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `version` | integer | Case file schema version. Currently `1`. |
| `scenario` | string | Must match the directory name, which must match the sidecar's `key`. |
| `cases` | array | One or more test cases. |
| `cases[].name` | string | A short, unique name for the case. |
| `cases[].input` | object | The input the scenario would receive. |
| `cases[].expected` | object | What a correct run produces. Shape depends on the assertion style below. |

## Deterministic scenarios

For a scenario with fixed business logic, `expected` names the exact fields a correct run produces:

```json
{
  "name": "outbound-only",
  "input": { "inboundText": false, "outboundText": true },
  "expected": { "assignAgent": false }
}
```

## Generative-AI scenarios

For a scenario that calls an AI provider, exact-match assertions are too strict. Use `oneOf` to constrain a field to a set of acceptable values, and `prohibited` to list substrings the output must not contain:

```json
{
  "name": "interested-reply",
  "input": { "replyText": "sounds good, send me times" },
  "expected": {
    "classification": { "oneOf": ["interested", "highly_interested"] },
    "prohibited": ["unsubscribe"]
  }
}
```
