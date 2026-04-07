# Milestone Sync

This directory contains the reusable workflow and the Node.js tool that syncs a GitHub milestone to a Jira Epic.

The workflow YAML, script, package manifest, and example config are colocated in `.github/workflows` so the reusable workflow can check out a single directory tree and run in place.

## Reusable workflow

The reusable workflow lives at:

`dkropachev/jira/.github/workflows/milestone-sync-reusable.yml@main`

Caller example:

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
    uses: dkropachev/jira/.github/workflows/milestone-sync-reusable.yml@main
    with:
      milestone: ${{ inputs.milestone }}
      config-path: milestone-sync/config.yaml
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
