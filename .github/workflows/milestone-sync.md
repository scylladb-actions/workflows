# Milestone Sync

This directory contains the reusable workflow and the Node.js tool that syncs a GitHub milestone to a Jira Epic.

The workflow YAML, script, package manifest, and example config are colocated in `.github/workflows` so the reusable workflow can check out a single directory tree and run in place.

## Reusable workflow

The reusable workflow lives at:

`scylladb-actions/workflows/.github/workflows/milestone-sync-reusable.yml@<workflow-sha>`

Callers should pin that reference to a commit SHA.

On GitHub Enterprise Server, set `tool-ref` explicitly because GitHub documents `job.workflow_repository` and `job.workflow_sha` as unavailable there.

Caller example:

Manual:

```yaml
name: Sync Milestone

on:
  workflow_dispatch:
    inputs:
      milestone:
        required: true
        type: string

jobs:
  sync:
    uses: scylladb-actions/workflows/.github/workflows/milestone-sync-reusable.yml@<workflow-sha>
    with:
      milestone: ${{ inputs.milestone }}
      config-path: milestone-sync/config.yaml
    secrets:
      USER_AND_KEY_FOR_JIRA_AUTOMATION: ${{ secrets.USER_AND_KEY_FOR_JIRA_AUTOMATION }}
```

Automatic:

```yaml
name: Auto Sync Milestone

on:
  milestone:
    types: [created, edited, opened, closed]
  issues:
    types: [opened, closed, reopened, milestoned, demilestoned]

jobs:
  sync:
    uses: scylladb-actions/workflows/.github/workflows/milestone-sync-reusable.yml@<workflow-sha>
    with:
      config-path: milestone-sync/config.yaml
      github-event-name: ${{ github.event_name }}
      github-event-payload: ${{ toJson(github.event) }}
    secrets:
      USER_AND_KEY_FOR_JIRA_AUTOMATION: ${{ secrets.USER_AND_KEY_FOR_JIRA_AUTOMATION }}
```

## Caller repository config

Store the config file in the caller repository, for example at `milestone-sync/config.yaml`:

```yaml
Project: "DRIVER"
Issue Type: "Epic"
Summary Prefix: "nodejs-rs-driver:"
Scylla Components: "Driver - nodejs-rs-driver"
Assignee: "Stanislaw Czech"
Team: "Drivers Team"
```

An example of that file is included here as `.github/workflows/milestone-sync.config.example.yaml`.
