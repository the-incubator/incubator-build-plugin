---
name: inc:cloudbuild-test-local
description: "Test a Cloud Build config (cloudbuild.yaml) locally before pushing, using the cloud-build-local tool. Use whenever a cloudbuild.yaml / cloudbuild.yml is created or substantially changed (steps added/removed/reordered, images, args, substitutions, secrets, timeouts) so the config is validated on the machine instead of burning a real Cloud Build run to find a typo. Triggers on \"test cloudbuild locally\", \"cloud-build-local\", \"validate my cloudbuild.yaml\", \"/inc:cloudbuild-test-local\". Also covers running a Cloud Run service locally with gcloud."
allowed-tools: Read, Bash(docker *), Bash(gcloud *), Bash(cloud-build-local *)
---

# Test Cloud Build configs locally

> **Google Cloud–specific skill.** This one deliberately names Cloud Build / Cloud Run because it exists to test those configs. It is the intentional exception to this plugin's usual pipeline-agnostic copy rule — do not use it as a precedent for naming other pipelines in unrelated skills.

Testing a `cloudbuild.yaml` locally catches config errors (bad step syntax, wrong image, broken substitutions, missing files, failing build steps) in seconds on your machine, instead of pushing and waiting for a real Cloud Build run to fail.

The tool for this is **`cloud-build-local`** — it runs the exact steps from your `cloudbuild.yaml` in local Docker containers, the same way hosted Cloud Build would.

> This is a different thing from running a Cloud Run **service** locally. If the goal is "run my app/container locally like Cloud Run", jump to [Running a Cloud Run service locally](#running-a-cloud-run-service-locally) at the bottom. This skill's main job is validating the **build config**.

## When to run this

Run a local test **whenever a `cloudbuild.yaml` is created or substantially changed** — before committing or pushing. "Substantial" means anything that changes what the build actually does:

- Adding, removing, or reordering build steps
- Changing a step's `name` (builder image), `args`, `entrypoint`, `dir`, or `env`
- Changing `images`, `artifacts`, `substitutions`, `options`, `timeout`, or secrets
- Editing referenced scripts, Dockerfiles, or files the steps depend on

Trivial edits (a comment, a whitespace change) don't need a run.

## Prerequisites

1. **Docker must be running** — `cloud-build-local` executes each step in a container.
   ```bash
   docker info >/dev/null 2>&1 && echo "docker ok" || echo "start Docker Desktop first"
   ```
2. **Authenticated gcloud** with the target project set (needed if steps pull private images or touch GCP):
   ```bash
   gcloud config get-value project
   ```
   If auth is stale, re-authenticate with `gcloud auth login` (and `gcloud auth application-default login` if your build steps read application-default credentials).
3. **Install the tool once** (it ships as a gcloud component):
   ```bash
   gcloud components install cloud-build-local
   ```
   Verify it's on PATH:
   ```bash
   cloud-build-local --help
   ```

## The workflow: dry-run first, then real run

Always do the cheap validation pass before the full one.

### Step 1 — Dry run (validate config, print the commands)

`--dryrun` defaults to **true**. This parses the config and prints the docker commands it *would* run without executing any step. It's the fast "is my YAML valid?" check.

```bash
cloud-build-local --config=cloudbuild.yaml --dryrun=true .
```

- The final positional arg (`.`) is the **source directory** (build context), usually the repo root or wherever the `cloudbuild.yaml`'s steps expect to run.
- If this errors, the config is malformed — fix it before going further. A clean dry run means the config parses and substitutions resolve.

### Step 2 — Real local run (actually execute the steps)

Once the dry run is clean, execute the steps for real in local Docker:

```bash
cloud-build-local --config=cloudbuild.yaml --dryrun=false .
```

- By default images are built but **not pushed** to any registry — safe.
- Add substitutions your build expects (Cloud Build does not inject `$PROJECT_ID`, `$SHORT_SHA`, etc. locally, so supply the ones your steps read):
  ```bash
  cloud-build-local \
    --config=cloudbuild.yaml \
    --dryrun=false \
    --substitutions=_ENV=staging,SHORT_SHA=local,COMMIT_SHA=local \
    .
  ```
- Only add `--push` if you actually intend to push resulting images to the registry (usually you don't for a local test):
  ```bash
  cloud-build-local --config=cloudbuild.yaml --dryrun=false --push .
  ```

A successful real run means every step exited 0 locally — a strong signal the config will pass in hosted Cloud Build.

## Flag reference

| Flag | Default | Purpose |
|------|---------|---------|
| `--config=<path>` | `cloudbuild.yaml` | Path to the Cloud Build config to test. |
| `--dryrun` | `true` | `true` = only parse + print the commands; `false` = actually run the steps. |
| `--push` | `false` | Push resulting images to the registry after the build. Leave off for local validation. |
| `--substitutions=K=V,K2=V2` | none | Provide substitution variables the steps reference (`$PROJECT_ID`, `$_FOO`, etc. are **not** auto-populated locally). |
| `--no-source` | `false` | Run the config without a source directory (for builds that don't need a workspace). |
| `--write-workspace=<dir>` | none | Copy the resulting `/workspace` out to a host directory to inspect artifacts a build produced. |
| `--bind-mount-source` | `false` | Bind-mount the source into the workspace instead of copying it in. |
| `<dir>` (positional) | — | The source / build-context directory (e.g. `.`). |

Run `cloud-build-local --help` for the full, version-current list.

## Limitations (why local ≠ 100% parity)

`cloud-build-local` is a best-effort local debugging tool, not a perfect emulator. Expect these gaps:

- **Only one build runs at a time** per host.
- **Linux and macOS only.**
- Some hosted-only features don't behave identically locally — automatic substitutions (`$PROJECT_ID`, `$BUILD_ID`, `$COMMIT_SHA`, `$SHORT_SHA`, `$TAG_NAME`), Cloud Build **secrets / Secret Manager / KMS** integration, IAM as the Cloud Build service account, `availableSecrets`, and network/worker-pool options. Supply substitutions manually and don't treat secret-dependent steps as fully verified.
- A clean local run validates **config shape and step logic**; it does not guarantee identical behavior for steps that depend on the hosted environment. Still push and watch the real run for those.

If a step fails only locally because of one of these gaps (e.g. a missing auto-substitution), note it rather than "fixing" the config to satisfy the local tool.

## Running a Cloud Run service locally

Different need: this runs your **service/container** locally the way Cloud Run would, rather than validating a build config. From the directory with your service source (Dockerfile or buildpack-compatible source):

```bash
gcloud beta code dev
```

- Serves at `http://localhost:8080/`. Use `--local-port=PORT` for a different port.
- To let the local service reach GCP APIs with your credentials:
  ```bash
  gcloud auth application-default login
  gcloud beta code dev --dockerfile=PATH_TO_DOCKERFILE --application-default-credential
  ```
- Or run it as a specific service account:
  ```bash
  gcloud beta code dev --dockerfile=PATH_TO_DOCKERFILE --service-account=SERVICE_ACCOUNT_EMAIL
  ```

Reference: https://docs.cloud.google.com/run/docs/testing/local#gcloud-cli

## Reporting back

After a local test, tell the user plainly:
- Which config was tested and with what substitutions.
- Whether the dry run and the real run each passed, with the failing step + error if not.
- Any step that couldn't be fully verified locally due to the parity gaps above, so they know to watch it in the real run.
