# Antigravity CLI

Install the repository root, which contains `plugin.json` and the shared `skills/` corpus:

```bash
agy plugin install https://github.com/the-incubator/incubator-build-plugin
agy plugin list
```

For a pinned or local checkout, check out the desired commit and run `agy plugin install /absolute/path/to/incubator-build-plugin`.
Do not install the `.agy/` subdirectory: it is documentation only, avoiding another copy or symlinked package root.
Start a new session, then ask to use `inc:guide` or explicitly read its installed `SKILL.md` if the host's name validator rejects legacy names.
See the [host matrix and limitations](../README.md); legacy Gemini extension conversion is not provided.
