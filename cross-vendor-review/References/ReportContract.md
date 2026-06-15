# Report contract -- the calling agent's output

On a successful review, emit EXACTLY this block, populated from the schema `json` the provider returned. The `SUBJECT` line and the markdown framing are the calling agent's; every finding / strength / verdict comes straight from the JSON -- do not add, drop, or soften any.

```
CROSS-VENDOR REVIEW [provider:model]
====================================
MODE: [plan | test-spec | code]
SUBJECT: [what was reviewed -- plan/spec path / diff range / file list]
FINDINGS:
  - [critical | warning | info] [ref | n/a] -- [one-sentence issue] | evidence: [what supports this]
  - [...]
STRENGTHS:
  - [what is right -- keeps the review balanced]
RECOMMENDATION: [approve | concerns | block]   <- the schema `verdict`
COMPLETED: [12-word summary]
```

On a failed call, emit the `ErrorVerdict` verbatim instead and nothing else:

```
{"verdict": "unavailable | setup-required | rate-limited | skipped | error", "reason": "..."}
```

Rules:
- Nothing before the block, nothing after it. No narration of the packaging/dispatch steps. No description of the shell call.
- The block is a reshaping of the provider's JSON, not new content. If you are writing review prose of your own, stop -- that is not this skill's job.
- Token/budget accounting is the CLI's job (it auto-records the daily request count and writes the call trail). Do not report it.
- There is no separate JSON output: the structured contract is `review-schema.json` (what the provider fills); the calling agent consumes the markdown block above. One output shape, no duplication.
