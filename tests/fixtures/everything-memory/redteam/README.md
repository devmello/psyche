
## Recorded responses

`../redteam-recordings/{cloud,local}.json` hold one raw model reply per case. They are **synthetic**:
written to mimic a model that obeyed the injection (cloud: clean closed-form JSON) or was sloppier
about the form (local: code fences, prose around the JSON, an extra field, truncated, double
encoded). No model produced them and none was started to make them. The third-party gate replays
every one of them through the whole pass (`third-party-redteam.test.ts`). To re-record from real
models, run the same cases against a cloud key or a local server the owner started, and replace the
files; that is done on demand, never in CI.
