import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = new URL('./milestone-sync.js', import.meta.url);
const CONFIG_TEXT = [
  'Project: "TEST"',
  'Issue Type: "Epic"',
  'Summary Prefix: "temp:"',
].join('\n');

function shouldRunLiveGitHubTests(env = process.env) {
  const value = env.MILESTONE_SYNC_INTERNAL_RUN_LIVE_GITHUB_TESTS;
  if (!value) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveGitHubToken() {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN;
  }
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }

  try {
    return execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function githubHeaders(token, extraHeaders = {}) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'jira-milestone-sync-live-test',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extraHeaders,
  };
}

async function githubRequest(token, pathname, options = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: githubHeaders(token, options.headers),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`);
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

async function githubListIssuesForMilestone(token, owner, repo, milestoneNumber) {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?milestone=${milestoneNumber}&state=all&per_page=100`,
    { headers: githubHeaders(token) },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`);
  }

  const items = await response.json();
  return items.filter((item) => !item.pull_request);
}

async function waitForIssueCount(token, owner, repo, milestoneNumber, expectedCount) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const items = await githubListIssuesForMilestone(token, owner, repo, milestoneNumber);
    if (items.length === expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  const finalItems = await githubListIssuesForMilestone(token, owner, repo, milestoneNumber);
  throw new Error(`Timed out waiting for milestone #${milestoneNumber} to contain ${expectedCount} issues; found ${finalItems.length}.`);
}

function runGit(args, cwd, token) {
  const authHeader = Buffer.from(`x-access-token:${token}`).toString('base64');
  return execFileSync('git', [
    '-c',
    `http.https://github.com/.extraheader=AUTHORIZATION: basic ${authHeader}`,
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function seedRepository(token, owner, repo, rootDir) {
  const seedDir = path.join(rootDir, 'seed');
  await fsPromises.mkdir(seedDir, { recursive: true });
  await fsPromises.mkdir(path.join(seedDir, 'milestone-sync'), { recursive: true });
  await fsPromises.writeFile(path.join(seedDir, 'README.md'), '# temp repo\n', 'utf8');
  await fsPromises.writeFile(path.join(seedDir, 'milestone-sync', 'config.yaml'), `${CONFIG_TEXT}\n`, 'utf8');

  runGit(['init', '--initial-branch=main'], seedDir, token);
  runGit(['config', 'user.name', 'Milestone Sync Test'], seedDir, token);
  runGit(['config', 'user.email', 'milestone-sync-test@example.com'], seedDir, token);
  runGit(['add', '.'], seedDir, token);
  runGit(['commit', '-m', 'Seed test repo'], seedDir, token);
  runGit(['remote', 'add', 'origin', `https://github.com/${owner}/${repo}.git`], seedDir, token);
  runGit(['push', '--set-upstream', 'origin', 'main'], seedDir, token);

  const cloneDir = path.join(rootDir, 'clone');
  runGit(['clone', `https://github.com/${owner}/${repo}.git`, cloneDir], rootDir, token);
  return cloneDir;
}

async function runTool({ token, owner, repo, cloneDir, args }) {
  const env = {
    ...process.env,
    GITHUB_TOKEN: token,
    GITHUB_REPOSITORY: `${owner}/${repo}`,
    MILESTONE_SYNC_INTERNAL_DRY_RUN: '1',
    MILESTONE_SYNC_INTERNAL_GITHUB_ONLY_DRY_RUN: '1',
  };
  delete env.USER_AND_KEY_FOR_JIRA_AUTOMATION;

  const { stdout, stderr } = await execFileAsync('node', [SCRIPT_PATH.pathname, ...args], {
    cwd: cloneDir,
    env,
  });

  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function runToolLines(options) {
  const result = await runTool(options);
  assert.equal(result.stderr, '');
  return result.stdout.split('\n');
}

async function createTempRepository(token) {
  const repoName = `milestone-sync-dry-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const repo = await githubRequest(token, '/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: repoName,
      private: true,
      auto_init: false,
      delete_branch_on_merge: true,
    }),
  });

  return {
    owner: repo.owner.login,
    repo: repo.name,
  };
}

async function deleteRepository(token, owner, repo) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    method: 'DELETE',
    headers: githubHeaders(token),
  });
  if (!response.ok && response.status !== 404) {
    return false;
  }
  return true;
}

async function writeEventPayload(rootDir, name, payload) {
  const eventPath = path.join(rootDir, `${name}.json`);
  await fsPromises.writeFile(eventPath, JSON.stringify(payload, null, 2), 'utf8');
  return eventPath;
}

function expectedDryRunLines(milestoneNumber, milestoneTitle, issueCount) {
  return [
    `dry-run: would create-or-update Jira issue from milestone #${milestoneNumber} (${milestoneTitle}); synced ${issueCount} issues.`,
    `  - prepare Jira Epic summary "temp: ${milestoneTitle}"`,
    '  - create-or-update Jira Epic in project TEST',
    '  - skip Jira-specific lookups and field resolution in GitHub-only dry-run',
    '  - update GitHub milestone description with Jira link',
  ];
}

test('live github-only dry-run follows milestone assignment and move flows on a real temp repo', { timeout: 300000 }, async (t) => {
  if (!shouldRunLiveGitHubTests()) {
    t.skip('Set MILESTONE_SYNC_INTERNAL_RUN_LIVE_GITHUB_TESTS=1 to run live GitHub integration tests.');
  }

  const token = resolveGitHubToken();
  if (!token) {
    t.skip('No GitHub token available via env or gh auth.');
  }

  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'milestone-sync-live-'));
  let tempRepo = null;

  try {
    tempRepo = await createTempRepository(token);
    const cloneDir = await seedRepository(token, tempRepo.owner, tempRepo.repo, tempRoot);

    const alpha = await githubRequest(token, `/repos/${tempRepo.owner}/${tempRepo.repo}/milestones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Release Alpha',
        description: 'Alpha release milestone',
      }),
    });
    const configPath = path.join(cloneDir, 'milestone-sync', 'config.yaml');
    const alphaCreatedEventPath = await writeEventPayload(tempRoot, 'alpha-created-event', {
      action: 'created',
      milestone: {
        number: alpha.number,
        title: alpha.title,
      },
    });

    assert.deepEqual(await runToolLines({
      token,
      owner: tempRepo.owner,
      repo: tempRepo.repo,
      cloneDir,
      args: [
        'sync-event',
        '--config',
        configPath,
        '--event-name',
        'milestone',
        '--event-path',
        alphaCreatedEventPath,
        '--dry-run',
      ],
    }), expectedDryRunLines(alpha.number, alpha.title, 0));

    const issueOne = await githubRequest(token, `/repos/${tempRepo.owner}/${tempRepo.repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Issue One',
        body: 'Created without a milestone first',
      }),
    });

    await githubRequest(token, `/repos/${tempRepo.owner}/${tempRepo.repo}/issues/${issueOne.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestone: alpha.number }),
    });
    await waitForIssueCount(token, tempRepo.owner, tempRepo.repo, alpha.number, 1);

    const issueOneMilestonedEventPath = await writeEventPayload(tempRoot, 'issue-one-milestoned-event', {
      action: 'milestoned',
      issue: {
        number: issueOne.number,
        milestone: {
          number: alpha.number,
          title: alpha.title,
        },
      },
    });

    assert.deepEqual(await runToolLines({
      token,
      owner: tempRepo.owner,
      repo: tempRepo.repo,
      cloneDir,
      args: [
        'sync-event',
        '--config',
        configPath,
        '--event-name',
        'issues',
        '--event-path',
        issueOneMilestonedEventPath,
        '--dry-run',
      ],
    }), expectedDryRunLines(alpha.number, alpha.title, 1));

    await githubRequest(token, `/repos/${tempRepo.owner}/${tempRepo.repo}/issues/${issueOne.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestone: null }),
    });
    await waitForIssueCount(token, tempRepo.owner, tempRepo.repo, alpha.number, 0);

    const issueOneDemilestonedEventPath = await writeEventPayload(tempRoot, 'issue-one-demilestoned-event', {
      action: 'demilestoned',
      changes: {
        milestone: {
          from: {
            number: alpha.number,
            title: alpha.title,
          },
        },
      },
      issue: {
        number: issueOne.number,
        milestone: null,
      },
    });

    assert.deepEqual(await runToolLines({
      token,
      owner: tempRepo.owner,
      repo: tempRepo.repo,
      cloneDir,
      args: [
        'sync-event',
        '--config',
        configPath,
        '--event-name',
        'issues',
        '--event-path',
        issueOneDemilestonedEventPath,
        '--dry-run',
      ],
    }), expectedDryRunLines(alpha.number, alpha.title, 0));

    const beta = await githubRequest(token, `/repos/${tempRepo.owner}/${tempRepo.repo}/milestones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Release Beta',
        description: 'Beta release milestone',
      }),
    });
    const betaCreatedEventPath = await writeEventPayload(tempRoot, 'beta-created-event', {
      action: 'created',
      milestone: {
        number: beta.number,
        title: beta.title,
      },
    });

    assert.deepEqual(await runToolLines({
      token,
      owner: tempRepo.owner,
      repo: tempRepo.repo,
      cloneDir,
      args: [
        'sync-event',
        '--config',
        configPath,
        '--event-name',
        'milestone',
        '--event-path',
        betaCreatedEventPath,
        '--dry-run',
      ],
    }), expectedDryRunLines(beta.number, beta.title, 0));

    const issueTwo = await githubRequest(token, `/repos/${tempRepo.owner}/${tempRepo.repo}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Issue Two',
        body: 'Starts without a milestone and then moves',
      }),
    });

    await githubRequest(token, `/repos/${tempRepo.owner}/${tempRepo.repo}/issues/${issueTwo.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestone: beta.number }),
    });
    await waitForIssueCount(token, tempRepo.owner, tempRepo.repo, beta.number, 1);

    const issueTwoMilestonedEventPath = await writeEventPayload(tempRoot, 'issue-two-milestoned-event', {
      action: 'milestoned',
      issue: {
        number: issueTwo.number,
        milestone: {
          number: beta.number,
          title: beta.title,
        },
      },
    });

    assert.deepEqual(await runToolLines({
      token,
      owner: tempRepo.owner,
      repo: tempRepo.repo,
      cloneDir,
      args: [
        'sync-event',
        '--config',
        configPath,
        '--event-name',
        'issues',
        '--event-path',
        issueTwoMilestonedEventPath,
        '--dry-run',
      ],
    }), expectedDryRunLines(beta.number, beta.title, 1));

    await githubRequest(token, `/repos/${tempRepo.owner}/${tempRepo.repo}/issues/${issueTwo.number}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestone: alpha.number }),
    });
    await waitForIssueCount(token, tempRepo.owner, tempRepo.repo, beta.number, 0);
    await waitForIssueCount(token, tempRepo.owner, tempRepo.repo, alpha.number, 1);

    const moveEventPath = await writeEventPayload(tempRoot, 'issue-two-moved-event', {
      action: 'edited',
      changes: {
        milestone: {
          from: {
            number: beta.number,
            title: beta.title,
          },
        },
      },
      issue: {
        number: issueTwo.number,
        milestone: {
          number: alpha.number,
          title: alpha.title,
        },
      },
    });

    assert.deepEqual(await runToolLines({
      token,
      owner: tempRepo.owner,
      repo: tempRepo.repo,
      cloneDir,
      args: [
        'sync-event',
        '--config',
        configPath,
        '--event-name',
        'issues',
        '--event-path',
        moveEventPath,
        '--dry-run',
      ],
    }), [
      ...expectedDryRunLines(beta.number, beta.title, 0),
      ...expectedDryRunLines(alpha.number, alpha.title, 1),
    ]);

    const noopEventPath = await writeEventPayload(tempRoot, 'noop-event', {
      action: 'assigned',
      issue: {
        number: issueTwo.number,
        milestone: {
          number: alpha.number,
          title: alpha.title,
        },
      },
    });

    const noopResult = await runTool({
      token,
      owner: tempRepo.owner,
      repo: tempRepo.repo,
      cloneDir,
      args: [
        'sync-event',
        '--config',
        configPath,
        '--event-name',
        'issues',
        '--event-path',
        noopEventPath,
        '--dry-run',
      ],
    });
    assert.equal(noopResult.stdout, 'No milestone sync needed for GitHub event issues/assigned.');
    assert.equal(noopResult.stderr, '');
  } finally {
    if (tempRepo) {
      await deleteRepository(token, tempRepo.owner, tempRepo.repo);
    }
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});
