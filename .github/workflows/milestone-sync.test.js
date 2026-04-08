import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGitHubManagedBlock,
  buildJiraManagedNodes,
  classifyIssueStatus,
  findSprintForDate,
  findNearestGitRoot,
  formatSyncResultLine,
  getGitHubRepo,
  getGitHubRepoFromEnv,
  isDryRunEnabled,
  isGitHubOnlyDryRunEnabled,
  mergeGitHubDescription,
  mergeJiraDescription,
  normalizeConfig,
  parseJiraKeyFromGitHubDescription,
  parseGitHubRepoFromRemoteUrl,
  quarterLabelFromDate,
  resolveMilestoneSelectorsFromGitHubEvent,
  shouldPopulateConfiguredAssignee,
  stripGitHubManagedBlock,
} from './milestone-sync.js';

test('normalizeConfig rejects legacy multi-repo config', () => {
  assert.throws(
    () => normalizeConfig({ repos: [] }),
    /single-repo config\.yaml/,
  );
});

test('normalizeConfig accepts jira-only config', () => {
  const config = normalizeConfig({
    Project: 'DRIVER',
    'Issue Type': 'Epic',
    'Summary Prefix': 'nodejs-rs-driver:',
    'Scylla Components': 'Driver - nodejs-rs-driver',
    Assignee: 'it.admin@scylladb.com',
    Team: 'Drivers Team',
  });

  assert.equal(config.jira.project, 'DRIVER');
  assert.equal(config.jira.url, 'https://scylladb.atlassian.net');
  assert.equal(config.jira.summaryPrefix, 'nodejs-rs-driver:');
  assert.equal(config.jira.assignee, 'it.admin@scylladb.com');
  assert.equal(config.jira.team, 'Drivers Team');
});

test('normalizeConfig still accepts legacy nested jira keys', () => {
  const config = normalizeConfig({
    jira: {
      project: 'DRIVER',
      issue_type: 'Epic',
      summary_prefix: 'nodejs-rs-driver:',
      scylla_components: 'Driver - nodejs-rs-driver',
      assignee: 'Stanislaw Czech',
      team: 'Drivers Team',
    },
  });

  assert.equal(config.jira.issueType, 'Epic');
  assert.equal(config.jira.assignee, 'Stanislaw Czech');
});

test('getGitHubRepoFromEnv parses GITHUB_REPOSITORY', () => {
  assert.deepEqual(
    getGitHubRepoFromEnv({ GITHUB_REPOSITORY: 'scylladb/nodejs-rs-driver' }),
    { owner: 'scylladb', repo: 'nodejs-rs-driver' },
  );
});

test('parseGitHubRepoFromRemoteUrl parses ssh and https remotes', () => {
  assert.deepEqual(
    parseGitHubRepoFromRemoteUrl('git@github.com:scylladb/nodejs-rs-driver.git'),
    { owner: 'scylladb', repo: 'nodejs-rs-driver' },
  );
  assert.deepEqual(
    parseGitHubRepoFromRemoteUrl('https://github.com/scylladb/nodejs-rs-driver.git'),
    { owner: 'scylladb', repo: 'nodejs-rs-driver' },
  );
});

test('findNearestGitRoot walks up to the closest .git marker', () => {
  const existing = new Set([
    '/tmp/repo/.git',
  ]);
  const existsSync = (candidate) => existing.has(candidate);

  assert.equal(findNearestGitRoot('/tmp/repo/tools/milestone-sync', existsSync), '/tmp/repo');
  assert.equal(findNearestGitRoot('/tmp/no-repo/tools', existsSync), null);
});

test('getGitHubRepo falls back to nearest git origin remote', () => {
  const existing = new Set([
    '/workspace/project/.git',
  ]);
  const existsSync = (candidate) => existing.has(candidate);

  assert.deepEqual(
    getGitHubRepo({}, {
      cwd: '/workspace/project/tools/milestone-sync',
      existsSync,
      execGit: () => 'git@github.com:scylladb-actions/workflows.git',
    }),
    {
      source: 'git',
      root: '/workspace/project',
      owner: 'scylladb-actions',
      repo: 'workflows',
    },
  );
});

test('isDryRunEnabled only turns on for the hidden internal switch', () => {
  assert.equal(isDryRunEnabled({}), false);
  assert.equal(isDryRunEnabled({ MILESTONE_SYNC_INTERNAL_DRY_RUN: '1' }), true);
  assert.equal(isDryRunEnabled({ MILESTONE_SYNC_INTERNAL_DRY_RUN: 'true' }), true);
  assert.equal(isDryRunEnabled({}, true), true);
});

test('isGitHubOnlyDryRunEnabled only turns on for the hidden internal switch', () => {
  assert.equal(isGitHubOnlyDryRunEnabled({}), false);
  assert.equal(isGitHubOnlyDryRunEnabled({ MILESTONE_SYNC_INTERNAL_GITHUB_ONLY_DRY_RUN: '1' }), true);
  assert.equal(isGitHubOnlyDryRunEnabled({ MILESTONE_SYNC_INTERNAL_GITHUB_ONLY_DRY_RUN: 'true' }), true);
});

test('formatSyncResultLine renders dry-run output without a Jira key for creates', () => {
  assert.equal(
    formatSyncResultLine({
      dryRun: true,
      action: 'would create',
      jiraKey: null,
      milestoneNumber: 12,
      milestoneTitle: 'Release 12',
      issueCount: 7,
    }),
    'dry-run: would create Jira issue from milestone #12 (Release 12); synced 7 issues.',
  );
});

test('formatSyncResultLine renders dry-run output for github-only create-or-update', () => {
  assert.equal(
    formatSyncResultLine({
      dryRun: true,
      action: 'would create-or-update',
      jiraKey: null,
      milestoneNumber: 13,
      milestoneTitle: 'Release 13',
      issueCount: 4,
    }),
    'dry-run: would create-or-update Jira issue from milestone #13 (Release 13); synced 4 issues.',
  );
});

test('resolveMilestoneSelectorsFromGitHubEvent returns the milestone for milestone events', () => {
  assert.deepEqual(
    resolveMilestoneSelectorsFromGitHubEvent('milestone', {
      action: 'edited',
      milestone: { number: 17, title: 'Release 17' },
    }),
    ['17'],
  );
});

test('resolveMilestoneSelectorsFromGitHubEvent returns the current milestone for issues lifecycle events', () => {
  assert.deepEqual(
    resolveMilestoneSelectorsFromGitHubEvent('issues', {
      action: 'closed',
      issue: { milestone: { number: 18 } },
    }),
    ['18'],
  );
  assert.deepEqual(
    resolveMilestoneSelectorsFromGitHubEvent('issues', {
      action: 'milestoned',
      issue: { milestone: { number: 19 } },
    }),
    ['19'],
  );
});

test('resolveMilestoneSelectorsFromGitHubEvent returns the previous milestone when an issue is removed', () => {
  assert.deepEqual(
    resolveMilestoneSelectorsFromGitHubEvent('issues', {
      action: 'demilestoned',
      changes: { milestone: { from: { number: 20 } } },
      issue: { milestone: null },
    }),
    ['20'],
  );
});

test('resolveMilestoneSelectorsFromGitHubEvent returns both milestones when an issue changes milestones in one edit', () => {
  assert.deepEqual(
    resolveMilestoneSelectorsFromGitHubEvent('issues', {
      action: 'edited',
      changes: { milestone: { from: { number: 21 } } },
      issue: { milestone: { number: 22 } },
    }),
    ['21', '22'],
  );
});

test('resolveMilestoneSelectorsFromGitHubEvent returns an empty list for unrelated events', () => {
  assert.deepEqual(
    resolveMilestoneSelectorsFromGitHubEvent('issues', {
      action: 'assigned',
      issue: { milestone: { number: 23 } },
    }),
    [],
  );
  assert.deepEqual(
    resolveMilestoneSelectorsFromGitHubEvent('pull_request', {
      action: 'closed',
    }),
    [],
  );
});

test('parseJiraKeyFromGitHubDescription reads managed link, plain URL, and plain key text', () => {
  assert.equal(
    parseJiraKeyFromGitHubDescription(buildGitHubManagedBlock('DRIVER-12', 'https://jira.example/browse/DRIVER-12')),
    'DRIVER-12',
  );
  assert.equal(
    parseJiraKeyFromGitHubDescription('See https://jira.example/browse/DRIVER-34 for details'),
    'DRIVER-34',
  );
  assert.equal(
    parseJiraKeyFromGitHubDescription('Jira Epic: DRIVER-56'),
    'DRIVER-56',
  );
});

test('quarterLabelFromDate derives Jira Delivery Quarter from due date', () => {
  assert.equal(quarterLabelFromDate('2026-01-01'), '2026 Q1');
  assert.equal(quarterLabelFromDate('2026-04-09'), '2026 Q2');
  assert.equal(quarterLabelFromDate('2026-12-31'), '2026 Q4');
});

test('findSprintForDate selects the sprint whose range contains the due date', () => {
  const sprint = findSprintForDate([
    { id: 1, name: 'Sprint 1', startDate: '2026-02-01T00:00:00.000Z', endDate: '2026-02-28T23:59:59.000Z' },
    { id: 2, name: 'Sprint 2', startDate: '2026-04-01T00:00:00.000Z', endDate: '2026-05-01T03:59:59.000Z' },
  ], '2026-04-09');

  assert.equal(sprint.id, 2);
  assert.equal(findSprintForDate([], '2026-04-09'), null);
});

test('classifyIssueStatus maps issues to planned, in-progress, and done', () => {
  assert.equal(classifyIssueStatus({ state: 'open' }, []).key, 'planned');
  assert.equal(classifyIssueStatus({ state: 'open' }, []).label, 'To be done');
  assert.equal(classifyIssueStatus({ state: 'open' }, [{ number: 1, merged: false }]).key, 'in_progress');
  assert.equal(classifyIssueStatus({ state: 'open' }, [{ number: 2, merged: true }]).key, 'done');
  assert.equal(classifyIssueStatus({ state: 'closed' }, []).key, 'done');
});

test('shouldPopulateConfiguredAssignee only fills assignee on create or when Jira issue is unassigned', () => {
  assert.equal(shouldPopulateConfiguredAssignee(null), true);
  assert.equal(shouldPopulateConfiguredAssignee({ fields: { assignee: null } }), true);
  assert.equal(
    shouldPopulateConfiguredAssignee({ fields: { assignee: { displayName: 'Stanislaw Czech' } } }),
    false,
  );
});

test('mergeGitHubDescription replaces an existing managed block', () => {
  const existing = [
    'Milestone body',
    '',
    buildGitHubManagedBlock('DRIVER-1', 'https://jira.example/browse/DRIVER-1'),
  ].join('\n');

  const merged = mergeGitHubDescription(existing, 'DRIVER-2', 'https://jira.example/browse/DRIVER-2');

  assert.equal(stripGitHubManagedBlock(merged), 'Milestone body');
  assert.match(merged, /DRIVER-2/);
  assert.doesNotMatch(merged, /DRIVER-1/);
});

test('buildJiraManagedNodes renders milestone issues as bullet list items', () => {
  const nodes = buildJiraManagedNodes({
    milestone: { title: 'Release 1', html_url: 'https://github.com/acme/repo/milestone/1' },
    issues: [
      {
        number: 10,
        title: 'Fix bug',
        state: 'open',
        html_url: 'https://github.com/acme/repo/issues/10',
        workflowStatus: { key: 'planned', label: 'To be done', color: 'neutral', emoji: '📝' },
      },
    ],
  });

  assert.equal(nodes[0].type, 'heading');
  assert.equal(nodes[0].content[0].text, 'Release Release 1');
  assert.equal(nodes[0].content[0].marks[0].attrs.href, 'https://github.com/acme/repo/milestone/1');
  assert.equal(nodes[1].type, 'heading');
  assert.equal(nodes[1].content[0].text, 'Issues in this milestone');
  assert.equal(nodes[2].type, 'bulletList');
  assert.equal(nodes[2].content[0].content[0].content[0].text, '📝 ');
  assert.equal(nodes[3].type, 'panel');
  assert.equal(nodes[3].attrs.panelType, 'note');
});

test('mergeJiraDescription replaces the whole Jira body on sync', () => {
  const merged = mergeJiraDescription({
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Old intro that should be removed' }] },
    ],
  }, {
    milestone: { title: 'Release 1', html_url: 'https://github.com/acme/repo/milestone/1' },
    issues: [],
  });

  assert.equal(merged.content[0].type, 'heading');
  assert.equal(merged.content.at(-1).type, 'panel');
  assert.equal(merged.content.at(-1).attrs.panelType, 'note');
});
