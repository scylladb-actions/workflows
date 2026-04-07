# Milestone Sync Reusable Workflow

This repository hosts a reusable GitHub Actions workflow that syncs a GitHub milestone to a Jira Epic.

The reusable workflow is published at:

`dkropachev/jira/.github/workflows/milestone-sync-reusable.yml@main`

The implementation files are colocated under `.github/workflows` so the reusable workflow can check out this repository and run the sync tool directly from there.

## What it does

- Resolves a GitHub milestone by number or exact title
- Reads a config file from the caller repository
- Creates or updates the corresponding Jira Epic
- Syncs milestone issue status information into Jira

## Inputs

- `milestone`: Required. GitHub milestone number or exact title.
- `config-path`: Optional. Path to the config file in the caller repository. Default: `milestone-sync/config.yaml`.
- `node-version`: Optional. Node.js version used by the workflow. Default: `20`.
- `tool-ref`: Optional. Ref of `dkropachev/jira` to check out for the reusable workflow support files. Default: `main`.

## Required secret

- `USER_AND_KEY_FOR_JIRA_AUTOMATION`: Jira credentials in `user:token` format.

## Caller workflow example

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
    uses: dkropachev/jira/.github/workflows/milestone-sync-reusable.yml@main
    with:
      milestone: ${{ inputs.milestone }}
      config-path: milestone-sync/config.yaml
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
