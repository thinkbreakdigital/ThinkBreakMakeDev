# Client rules

Client-specific rules, context, and requirements go here.

Data classification and AI-provider rules live in [`data-policy.json`](data-policy.json), not here. A client project edits that file directly to change what data classifications exist and which AI providers each one allows. `scripts/validate-governance.mjs` checks every scenario sidecar against it.
