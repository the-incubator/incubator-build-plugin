# OpenCode

Merge this entry into the existing `plugin` array in global or project `opencode.json` without removing other entries:

```json
{
  "plugin": ["incubator-build-plugin@git+https://github.com/the-incubator/incubator-build-plugin.git"]
}
```

For a pinned install, append `#<commit-or-tag>` to the Git URL.
For local development, point the plugin array at the absolute file URL of `.opencode/plugins/incubator-build.js` in a retained checkout after `npm ci`.
Restart OpenCode after configuration changes.
The package entry point adds root `skills/` to discovery and exposes commands using the actual frontmatter names, preserving any existing same-name commands.
It never installs hooks or custom agents.
Read-only smoke: `/inc:guide`, then confirm bundled references resolve from this installation rather than the current project.
Remove only this plugin array entry and restart to uninstall.
See the [host matrix and limitations](../README.md).
