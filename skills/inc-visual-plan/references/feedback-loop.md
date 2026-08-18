# Hosted source loop

The M1 API exposes source creation, reads, catalog lookup, listing, and complete source replacement.
The reviewer feedback and consume endpoints are Phase 3 work.

Use the `INC_BUILD` command array from the main skill's command setup.

## M1 commands

```bash
"${INC_BUILD[@]}" plan blocks
"${INC_BUILD[@]}" plan create --project <slug> --title "<title>" --plan <plan.mdx> [--canvas <canvas.mdx>]
"${INC_BUILD[@]}" plan get <planId> --out <directory>
"${INC_BUILD[@]}" plan list [--project <slug>] [--status <status>]
"${INC_BUILD[@]}" plan replace <planId> --plan <plan.mdx> [--canvas <canvas.mdx>] --expect <updatedAt>
```

`plan patch` is currently a compatibility name for the same complete replacement request.
It does not send Phase 3 patch operations.

## Source safety

`PUT .../source` treats `files` as a complete replacement.
An omitted `canvas.mdx` is deleted from the stored source.
Always pass the full current file set.

Read immediately before a destructive write and pass its exact millisecond `updatedAt` as `expectedUpdatedAt`.
The `plan get --out` command prints that fence to stderr while it writes the source files.
If the API returns a stale response, read again and reconcile instead of overwriting newer work.
Read again after every successful write.

## Deliverable

`plan create` prints the `/p/` URL to stdout and metadata to stderr.
Copy the stdout URL verbatim into chat.
The URL is the hosted review deliverable.

## Deferred feedback

Do not call `plan feedback` or `plan consume` as if they were live.
The CLI keeps both verbs as explicit stubs until the Phase 3 feedback API exists.
When that API lands, consume and resolve remain separate axes, and only addressed agent-targeted feedback may be resolved.
