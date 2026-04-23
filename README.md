# Milestone Sync Reusable Workflow

This repository hosts a reusable GitHub Actions workflow that syncs a GitHub milestone to a Jira Epic.

The reusable workflow is published at:

`scylladb-actions/workflows/.github/workflows/milestone-sync-reusable.yml@<workflow-sha>`

Pin callers to a commit SHA rather than a branch or tag.

The implementation files are colocated under `.github/workflows` so the reusable workflow can check out this repository and run the sync tool directly from there.

## What it does

- Resolves a GitHub milestone by number or exact title
- Reads a config file from the caller repository
- Creates or updates the corresponding Jira Epic
- Syncs milestone issue status information into Jira

## Inputs

- `milestone`: Optional. GitHub milestone number or exact title for manual sync.
- `config-path`: Optional. Path to the config file in the caller repository. Default: `milestone-sync/config.yaml`.
- `node-version`: Optional. Node.js version used by the workflow. Default: `20`.
- `tool-ref`: Optional. Override ref for the reusable workflow support checkout. Default: the reusable workflow commit SHA on GitHub.com.

If you run this on GitHub Enterprise Server, set `tool-ref` explicitly because GitHub documents `job.workflow_repository` and `job.workflow_sha` as unavailable there.
- `github-event-name`: Optional. Original caller event name for automatic sync.
- `github-event-payload`: Optional. Original caller event payload, typically passed as `${{ toJson(github.event) }}`.

## Required secret

- `USER_AND_KEY_FOR_JIRA_AUTOMATION`: Jira credentials in `user:token` format.

## Caller workflow example

Manual:

```yaml
name: Sync Milestone

on:
  workflow_dispatch:
    inputs:
      milestone:
        description: Milestone number or exact title
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

## Caller config example

Store a config file in the caller repository, for example at `milestone-sync/config.yaml`:

```yaml
Project: "DRIVER"
Issue Type: "Epic"
Summary Prefix: "nodejs-rs-driver:"
Scylla Components: "Driver - nodejs-rs-driver"
Assignee: "Stanislaw Czech"
Team: "Drivers Team"
```

An example config is included in this repository at `.github/workflows/milestone-sync.config.example.yaml`.
