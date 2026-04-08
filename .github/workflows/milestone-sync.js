#!/usr/bin/env node

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const GITHUB_MARKER_START = '<!-- jira-milestone-sync:start -->';
const GITHUB_MARKER_END = '<!-- jira-milestone-sync:end -->';
const JIRA_BASE_URL = 'https://scylladb.atlassian.net';

function buildLegacyGitHubManagedBlockPattern() {
  return new RegExp(`${escapeRegExp(GITHUB_MARKER_START)}([\\s\\S]*?)${escapeRegExp(GITHUB_MARKER_END)}`);
}

function buildGitHubManagedBlockToEndPattern(flags = '') {
  return new RegExp(`${escapeRegExp(GITHUB_MARKER_START)}([\\s\\S]*)$`, flags);
}

function usage() {
  return [
    'Usage:',
    '  node milestone-sync.js sync --milestone <number|title> [--config path]',
    '  node milestone-sync.js sync-event [--config path] [--event-name name] [--event-path path]',
    '  node milestone-sync.js show-config [--config path]',
    '',
    'Auth:',
    '  GitHub: GITHUB_TOKEN or GH_TOKEN',
    '  Repo:   GITHUB_REPOSITORY=owner/repo, or nearest git origin remote',
    '  Jira:   USER_AND_KEY_FOR_JIRA_AUTOMATION=user:token',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    command: null,
    config: 'config.yaml',
    milestone: null,
    eventName: null,
    eventPath: null,
    dryRun: false,
  };
  const rest = [...argv];

  args.command = rest.shift() ?? null;
  while (rest.length > 0) {
    const current = rest.shift();
    if (current === '--config') {
      args.config = rest.shift();
    } else if (current === '--milestone') {
      args.milestone = rest.shift();
    } else if (current === '--event-name') {
      args.eventName = rest.shift();
    } else if (current === '--event-path') {
      args.eventPath = rest.shift();
    } else if (current === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${current}`);
    }
  }

  if (!args.command) {
    throw new Error('Missing command');
  }
  if (args.command === 'sync' && !args.milestone) {
    throw new Error('Missing --milestone');
  }
  if (!['sync', 'sync-event', 'show-config'].includes(args.command)) {
    throw new Error(`Unsupported command: ${args.command}`);
  }
  return args;
}

async function loadYamlModule() {
  try {
    return await import('yaml');
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error('Missing dependency "yaml". Run `npm install` first.');
    }
    throw error;
  }
}

function requireString(value, fieldPath) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required config field: ${fieldPath}`);
  }
  return value.trim();
}

function pickConfigValue(object, aliases) {
  for (const alias of aliases) {
    if (object && Object.prototype.hasOwnProperty.call(object, alias) && object[alias] != null) {
      return object[alias];
    }
  }
  return undefined;
}

export function normalizeConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new Error('Config file must contain a YAML object');
  }
  if (Array.isArray(rawConfig.repos)) {
    throw new Error('This tool expects a single-repo config.yaml, not the legacy multi-repo config.');
  }

  const jira = pickConfigValue(rawConfig, ['Jira', 'jira']) ?? rawConfig;

  return {
    jira: {
      url: JIRA_BASE_URL,
      project: requireString(pickConfigValue(jira, ['Project', 'project']), 'Project'),
      issueType: requireString(pickConfigValue(jira, ['Issue Type', 'issue_type', 'issueType']) ?? 'Epic', 'Issue Type'),
      summaryPrefix: typeof pickConfigValue(jira, ['Summary Prefix', 'summary_prefix', 'summaryPrefix']) === 'string'
        ? pickConfigValue(jira, ['Summary Prefix', 'summary_prefix', 'summaryPrefix']).trim()
        : '',
      scyllaComponents: typeof pickConfigValue(jira, ['Scylla Components', 'scylla_components', 'scyllaComponents']) === 'string'
        ? pickConfigValue(jira, ['Scylla Components', 'scylla_components', 'scyllaComponents']).trim()
        : '',
      assignee: typeof pickConfigValue(jira, ['Assignee', 'assignee']) === 'string'
        ? pickConfigValue(jira, ['Assignee', 'assignee']).trim()
        : '',
      team: typeof pickConfigValue(jira, ['Team', 'team']) === 'string'
        ? pickConfigValue(jira, ['Team', 'team']).trim()
        : '',
    },
  };
}

async function readConfig(configPath) {
  let text;
  try {
    text = await fsPromises.readFile(configPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `Config file not found: ${path.resolve(configPath)}. `
        + 'Pass --config with a valid file path, for example milestone-sync/config.yaml.',
      );
    }
    throw error;
  }
  const { parse } = await loadYamlModule();
  return normalizeConfig(parse(text));
}

function getGitHubToken() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error('Missing GitHub token. Set GITHUB_TOKEN or GH_TOKEN.');
  }
  return token;
}

export function parseGitHubRepo(value, sourceName = 'GitHub repository') {
  const match = String(value).match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) {
    throw new Error(`${sourceName} must be in owner/repo format.`);
  }
  return {
    owner: match[1],
    repo: match[2],
  };
}

export function parseGitHubRepoFromRemoteUrl(remoteUrl) {
  const trimmed = String(remoteUrl).trim();
  const match = trimmed.match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (!match) {
    throw new Error(`Unable to parse GitHub owner/repo from remote URL: ${trimmed}`);
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

export function findNearestGitRoot(startDir = process.cwd(), existsSync = fs.existsSync) {
  let current = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(current, '.git'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function defaultExecGit(repoRoot) {
  return execFileSync('git', ['-C', repoRoot, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function getGitHubRepo(env = process.env, options = {}) {
  const value = env.GITHUB_REPOSITORY;
  if (value) {
    return {
      source: 'env',
      ...parseGitHubRepo(value, 'GITHUB_REPOSITORY'),
    };
  }

  const repoRoot = findNearestGitRoot(options.cwd ?? process.cwd(), options.existsSync ?? fs.existsSync);
  if (!repoRoot) {
    throw new Error('Missing GitHub repository. Set GITHUB_REPOSITORY=owner/repo or run inside a git repository.');
  }

  let remoteUrl;
  try {
    remoteUrl = (options.execGit ?? defaultExecGit)(repoRoot);
  } catch (error) {
    throw new Error(`Unable to read git origin remote from ${repoRoot}: ${error.message}`);
  }

  return {
    source: 'git',
    root: repoRoot,
    ...parseGitHubRepoFromRemoteUrl(remoteUrl),
  };
}

export function getGitHubRepoFromEnv(env = process.env) {
  const value = env.GITHUB_REPOSITORY;
  if (!value) {
    throw new Error('Missing GitHub repository. Set GITHUB_REPOSITORY=owner/repo.');
  }
  return parseGitHubRepo(value, 'GITHUB_REPOSITORY');
}

export function isDryRunEnabled(env = process.env, cliFlag = false) {
  if (cliFlag) {
    return true;
  }

  const value = env.MILESTONE_SYNC_INTERNAL_DRY_RUN;
  if (!value) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function isGitHubOnlyDryRunEnabled(env = process.env) {
  const value = env.MILESTONE_SYNC_INTERNAL_GITHUB_ONLY_DRY_RUN;
  if (!value) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getGitHubEventName(env = process.env, override = null) {
  const value = override ?? env.GITHUB_EVENT_NAME;
  if (!value) {
    throw new Error('Missing GitHub event name. Set GITHUB_EVENT_NAME or pass --event-name.');
  }
  return String(value).trim();
}

function getGitHubEventPath(env = process.env, override = null) {
  const value = override ?? env.GITHUB_EVENT_PATH;
  if (!value) {
    throw new Error('Missing GitHub event path. Set GITHUB_EVENT_PATH or pass --event-path.');
  }
  return String(value).trim();
}

function milestoneSelectorFromEvent(value) {
  if (value == null) {
    return null;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return value.trim() || null;
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (value.number != null) {
      return String(value.number);
    }
    if (typeof value.title === 'string' && value.title.trim() !== '') {
      return value.title.trim();
    }
  }
  return null;
}

function uniqueMilestoneSelectors(values) {
  const result = [];
  for (const value of values) {
    if (!value || result.includes(value)) {
      continue;
    }
    result.push(value);
  }
  return result;
}

export function resolveMilestoneSelectorsFromGitHubEvent(eventName, eventPayload) {
  const normalizedEventName = String(eventName ?? '').trim();
  if (!normalizedEventName) {
    throw new Error('Missing GitHub event name.');
  }

  if (normalizedEventName === 'milestone') {
    return uniqueMilestoneSelectors([
      milestoneSelectorFromEvent(eventPayload?.milestone),
    ]);
  }

  if (normalizedEventName !== 'issues') {
    return [];
  }

  const action = String(eventPayload?.action ?? '').trim();
  const currentMilestone = milestoneSelectorFromEvent(eventPayload?.issue?.milestone);
  const previousMilestone = milestoneSelectorFromEvent(eventPayload?.changes?.milestone?.from);

  if (['opened', 'closed', 'reopened', 'milestoned'].includes(action)) {
    return uniqueMilestoneSelectors([currentMilestone]);
  }
  if (action === 'demilestoned') {
    return uniqueMilestoneSelectors([previousMilestone]);
  }
  if (action === 'edited' && previousMilestone) {
    return uniqueMilestoneSelectors([previousMilestone, currentMilestone]);
  }

  return [];
}

async function readGitHubEventPayload(eventPath) {
  let text;
  try {
    text = await fsPromises.readFile(eventPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`GitHub event payload not found: ${path.resolve(eventPath)}`);
    }
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`GitHub event payload is not valid JSON: ${error.message}`);
  }
}

function getJiraAuth() {
  const combined = process.env.USER_AND_KEY_FOR_JIRA_AUTOMATION;
  if (combined) {
    const splitIndex = combined.indexOf(':');
    if (splitIndex === -1) {
      throw new Error('USER_AND_KEY_FOR_JIRA_AUTOMATION must be in user:token format.');
    }
    return {
      user: combined.slice(0, splitIndex),
      token: combined.slice(splitIndex + 1),
    };
  }

  throw new Error('Missing Jira credentials. Set USER_AND_KEY_FOR_JIRA_AUTOMATION=user:token.');
}

function buildGitHubHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'jira-milestone-sync',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function githubRequest(token, pathname, options = {}) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    ...options,
    headers: {
      ...buildGitHubHeaders(token),
      ...(options.headers ?? {}),
    },
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

async function githubPaginatedRequest(token, pathname) {
  const items = [];
  let nextUrl = `https://api.github.com${pathname}`;

  while (nextUrl) {
    const response = await fetch(nextUrl, { headers: buildGitHubHeaders(token) });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status} ${response.statusText}: ${body}`);
    }
    items.push(...await response.json());

    const link = response.headers.get('link') ?? '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return items;
}

class JiraClient {
  constructor(baseUrl, user, token) {
    this.baseUrl = baseUrl;
    this.authHeader = `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}`;
    this.fieldCache = null;
  }

  async request(pathname, options = {}) {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: this.authHeader,
        ...(options.headers ?? {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Jira API ${response.status} ${response.statusText}: ${body}`);
    }

    if (response.status === 204) {
      return null;
    }
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      return response.json();
    }
    return response.text();
  }

  async getAllFields() {
    if (!this.fieldCache) {
      this.fieldCache = await this.request('/rest/api/3/field');
    }
    return this.fieldCache;
  }

  async findField(name, options = {}) {
    const { includeBuiltin = true, schemaType = null } = options;
    const fields = await this.getAllFields();
    const nameLower = name.toLowerCase();
    for (const field of fields) {
      if (!includeBuiltin && !field.custom) {
        continue;
      }
      if (field.name.toLowerCase() !== nameLower) {
        continue;
      }
      if (schemaType && field.schema?.type !== schemaType) {
        continue;
      }
      return field;
    }
    return null;
  }

  async searchIssues(jql, fields = ['summary']) {
    return this.request('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        maxResults: 100,
        fields,
      }),
    });
  }

  async getIssue(key, fields = ['*all']) {
    const params = new URLSearchParams();
    if (fields?.length) {
      params.set('fields', fields.join(','));
    }
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}?${params.toString()}`);
  }

  async createIssue(fields) {
    return this.request('/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({ fields }),
    });
  }

  async updateIssue(key, fields) {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify({ fields }),
    });
  }

  async getRemoteLinks(key) {
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`);
  }

  async addRemoteLink(key, url, title) {
    const existing = await this.getRemoteLinks(key);
    const match = existing.find((item) => item?.object?.url === url);
    if (match) {
      return match;
    }
    return this.request(`/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, {
      method: 'POST',
      body: JSON.stringify({
        object: { url, title },
      }),
    });
  }

  async getContexts(fieldId) {
    const response = await this.request(`/rest/api/3/field/${fieldId}/context`);
    return response.values ?? [];
  }

  async getOptions(fieldId, contextId) {
    let startAt = 0;
    const values = [];

    while (true) {
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: '1000' });
      const page = await this.request(`/rest/api/3/field/${fieldId}/context/${contextId}/option?${params.toString()}`);
      values.push(...(page.values ?? []));
      if (page.isLast ?? true) {
        return values;
      }
      startAt += page.values?.length ?? 0;
    }
  }

  async searchUsers(query) {
    const params = new URLSearchParams({ query });
    return this.request(`/rest/api/3/user/search?${params.toString()}`);
  }

  async getBoards(projectKey) {
    const params = new URLSearchParams({
      projectKeyOrId: projectKey,
      maxResults: '50',
    });
    const response = await this.request(`/rest/agile/1.0/board?${params.toString()}`);
    return response.values ?? [];
  }

  async getBoardSprints(boardId) {
    const params = new URLSearchParams({
      state: 'active,future,closed',
      maxResults: '100',
    });
    const response = await this.request(`/rest/agile/1.0/board/${boardId}/sprint?${params.toString()}`);
    return response.values ?? [];
  }

  async addIssueToSprint(sprintId, issueKey) {
    return this.request(`/rest/agile/1.0/sprint/${sprintId}/issue`, {
      method: 'POST',
      body: JSON.stringify({ issues: [issueKey] }),
    });
  }
}

function quoteJql(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isNumericMilestone(value) {
  return /^\d+$/.test(String(value));
}

async function resolveMilestone(token, owner, repo, milestoneSelector) {
  if (isNumericMilestone(milestoneSelector)) {
    return githubRequest(token, `/repos/${owner}/${repo}/milestones/${milestoneSelector}`);
  }

  const milestones = await githubPaginatedRequest(
    token,
    `/repos/${owner}/${repo}/milestones?state=all&per_page=100`,
  );
  const exactMatches = milestones.filter((item) => item.title === milestoneSelector);
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }
  if (exactMatches.length > 1) {
    throw new Error(`Multiple milestones found with title "${milestoneSelector}". Use the milestone number.`);
  }
  throw new Error(`Milestone not found: ${milestoneSelector}`);
}

async function listMilestoneIssues(token, owner, repo, milestoneNumber) {
  const items = await githubPaginatedRequest(
    token,
    `/repos/${owner}/${repo}/issues?milestone=${milestoneNumber}&state=all&per_page=100`,
  );
  return items
    .filter((item) => !item.pull_request)
    .sort((left, right) => left.number - right.number);
}

async function fetchAssociatedPullRequests(token, owner, repo, issueNumber) {
  const timeline = await githubPaginatedRequest(
    token,
    `/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`,
  );
  const pullRequestNumbers = new Set();

  for (const event of timeline) {
    const sourceIssue = event?.source?.issue;
    if (!sourceIssue?.pull_request) {
      continue;
    }
    if (typeof sourceIssue.number === 'number') {
      pullRequestNumbers.add(sourceIssue.number);
    }
  }

  return Promise.all([...pullRequestNumbers].map(async (pullRequestNumber) => {
    const pullRequest = await githubRequest(token, `/repos/${owner}/${repo}/pulls/${pullRequestNumber}`);
    return {
      number: pullRequest.number,
      url: pullRequest.html_url,
      state: pullRequest.state,
      merged: Boolean(pullRequest.merged_at),
      mergedAt: pullRequest.merged_at,
    };
  }));
}

export function classifyIssueStatus(issue, associatedPullRequests = []) {
  if (associatedPullRequests.some((pullRequest) => pullRequest.merged || pullRequest.mergedAt)) {
    return {
      key: 'done',
      label: 'Done',
      color: 'green',
      emoji: '✅',
    };
  }

  if (associatedPullRequests.length > 0) {
    return {
      key: 'in_progress',
      label: 'In-progress',
      color: 'blue',
      emoji: '🛠️',
    };
  }

  if (issue.state === 'closed') {
    return {
      key: 'done',
      label: 'Done',
      color: 'green',
      emoji: '✅',
    };
  }

  return {
    key: 'planned',
    label: 'To be done',
    color: 'neutral',
    emoji: '📝',
  };
}

async function enrichMilestoneIssues(token, owner, repo, issues) {
  return Promise.all(issues.map(async (issue) => {
    try {
      const associatedPullRequests = await fetchAssociatedPullRequests(token, owner, repo, issue.number);
      return {
        ...issue,
        associatedPullRequests,
        workflowStatus: classifyIssueStatus(issue, associatedPullRequests),
      };
    } catch (error) {
      console.warn(`Warning: failed to resolve PR state for issue #${issue.number}: ${error.message}`);
      return {
        ...issue,
        associatedPullRequests: [],
        workflowStatus: classifyIssueStatus(issue, []),
      };
    }
  }));
}

export function extractGitHubManagedBlock(text) {
  if (!text) {
    return null;
  }
  const match = text.match(buildLegacyGitHubManagedBlockPattern())
    ?? text.match(buildGitHubManagedBlockToEndPattern());
  return match ? match[1].trim() : null;
}

export function stripGitHubManagedBlock(text) {
  if (!text) {
    return '';
  }
  return text
    .replace(new RegExp(`\\n?${escapeRegExp(GITHUB_MARKER_START)}[\\s\\S]*?${escapeRegExp(GITHUB_MARKER_END)}\\n?`, 'g'), '\n')
    .replace(new RegExp(`\\n?${escapeRegExp(GITHUB_MARKER_START)}[\\s\\S]*$`, 'g'), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseJiraKeyFromGitHubDescription(text) {
  if (!text) {
    return null;
  }

  const managed = extractGitHubManagedBlock(text);
  if (managed) {
    const managedMatch = managed.match(/Jira Epic:\s*(?:\[)?([A-Z][A-Z0-9_]+-\d+)(?:\])?(?:\(|\b)/);
    if (managedMatch) {
      return managedMatch[1];
    }
  }

  const browseUrlMatch = text.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)\b/);
  if (browseUrlMatch) {
    return browseUrlMatch[1];
  }

  const plainTextMatch = text.match(/\bJira Epic:\s*([A-Z][A-Z0-9_]+-\d+)\b/);
  return plainTextMatch ? plainTextMatch[1] : null;
}

export function buildGitHubManagedBlock(jiraKey, jiraUrl) {
  return [
    GITHUB_MARKER_START,
    `Jira Epic: [${jiraKey}](${jiraUrl})`,
  ].join('\n');
}

export function mergeGitHubDescription(existing, jiraKey, jiraUrl) {
  const base = stripGitHubManagedBlock(existing);
  const block = buildGitHubManagedBlock(jiraKey, jiraUrl);
  return base ? `${base}\n\n${block}` : block;
}

function createTextNode(text, marks = []) {
  return { type: 'text', text, ...(marks.length > 0 ? { marks } : {}) };
}

function createParagraph(text) {
  return {
    type: 'paragraph',
    content: text ? [createTextNode(text)] : [],
  };
}

function createHeading(text, level = 2) {
  return {
    type: 'heading',
    attrs: { level },
    content: text ? [createTextNode(text)] : [],
  };
}

function createHeadingWithLink(text, href, level = 2) {
  return {
    type: 'heading',
    attrs: { level },
    content: text ? [createTextNode(text, [{ type: 'link', attrs: { href } }])] : [],
  };
}

function createParagraphWithLink(prefix, label, href) {
  const content = [];
  if (prefix) {
    content.push(createTextNode(prefix));
  }
  content.push(createTextNode(label, [{ type: 'link', attrs: { href } }]));
  return { type: 'paragraph', content };
}

function createPanel(panelType, content) {
  return {
    type: 'panel',
    attrs: { panelType },
    content,
  };
}

function createStatusNode(text, color) {
  return {
    type: 'status',
    attrs: { text, color },
  };
}

export function buildJiraManagedNodes({ milestone, issues }) {
  const counts = {
    planned: issues.filter((issue) => issue.workflowStatus?.key === 'planned').length,
    inProgress: issues.filter((issue) => issue.workflowStatus?.key === 'in_progress').length,
    done: issues.filter((issue) => issue.workflowStatus?.key === 'done').length,
  };
  const nodes = [
    createHeadingWithLink(`Release ${milestone.title}`, milestone.html_url, 1),
    createHeading('Issues in this milestone', 2),
  ];

  if (issues.length === 0) {
    nodes.push(
      createPanel('note', [
        createParagraph('🫙 No GitHub issues are currently assigned to this milestone.'),
      ]),
    );
  } else {
    nodes.push({
      type: 'bulletList',
      content: issues.map((issue) => ({
        type: 'listItem',
        content: [
          {
            type: 'paragraph',
            content: [
              createTextNode(`${issue.workflowStatus.emoji} `),
              createTextNode(issue.title, [
                { type: 'strong' },
                { type: 'link', attrs: { href: issue.html_url } },
              ]),
              createTextNode(` (#${issue.number}) `),
              createStatusNode(issue.workflowStatus.label, issue.workflowStatus.color),
            ],
          },
        ],
      })),
    });
  }

  nodes.push(
    createPanel('note', [
      {
        type: 'paragraph',
        content: [
          createTextNode('📊 Total: '),
          createTextNode(String(issues.length), [{ type: 'strong' }]),
          createTextNode('   '),
          createStatusNode(`To be done ${counts.planned}`, 'neutral'),
          createTextNode('   '),
          createStatusNode(`In-progress ${counts.inProgress}`, 'blue'),
          createTextNode('   '),
          createStatusNode(`Done ${counts.done}`, 'green'),
        ],
      },
    ]),
  );

  return nodes;
}

export function mergeJiraDescription(existingDescription, { milestone, issues, fallbackText = '' }) {
  const mergedContent = buildJiraManagedNodes({ milestone, issues });
  return {
    type: 'doc',
    version: 1,
    content: mergedContent,
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildExpectedSummary(config, milestoneTitle) {
  const prefix = config.jira.summaryPrefix.trim();
  return prefix ? `${prefix} ${milestoneTitle}`.trim() : milestoneTitle;
}

async function ensureScyllaComponentsOption(config, jira) {
  if (!config.jira.scyllaComponents) {
    return null;
  }

  const field = await jira.findField('Scylla Components', { includeBuiltin: false });
  if (!field) {
    throw new Error('Jira field "Scylla Components" was not found.');
  }
  const contexts = await jira.getContexts(field.id);
  if (contexts.length === 0) {
    throw new Error('Jira field "Scylla Components" has no contexts.');
  }
  const options = await jira.getOptions(field.id, contexts[0].id);
  const exact = options.find((item) => item.value === config.jira.scyllaComponents);
  if (!exact) {
    throw new Error(`Jira field option "Scylla Components=${config.jira.scyllaComponents}" does not exist.`);
  }
  return {
    id: field.id,
    isMulti: field.schema?.type === 'array',
  };
}

function formatSelectValue(value, isMulti) {
  return isMulti ? [{ value }] : { value };
}

function isoDateFromTimestamp(timestamp) {
  if (!timestamp) {
    return null;
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export function quarterLabelFromDate(dateText) {
  if (!dateText) {
    return null;
  }
  const match = String(dateText).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const quarter = Math.floor((month - 1) / 3) + 1;
  return `${year} Q${quarter}`;
}

function parseDateValue(dateText) {
  if (!dateText) {
    return null;
  }
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

export function findSprintForDate(sprints, dateText) {
  const target = parseDateValue(dateText);
  if (!target) {
    return null;
  }

  for (const sprint of sprints) {
    const start = parseDateValue(sprint.startDate);
    const end = parseDateValue(sprint.endDate);
    if (!start || !end) {
      continue;
    }
    if (target >= start && target <= end) {
      return sprint;
    }
  }

  return null;
}

async function resolveTeamId(teamName, jira, fieldId) {
  try {
    const result = await jira.searchIssues(`"Team" = ${quoteJql(teamName)} ORDER BY updated DESC`, [fieldId]);
    for (const issue of result.issues ?? []) {
      const fieldValue = issue.fields?.[fieldId];
      if (fieldValue?.id) {
        return String(fieldValue.id);
      }
    }
  } catch (error) {
    console.warn(`Warning: team JQL search failed for "${teamName}": ${error.message}`);
  }

  try {
    const params = new URLSearchParams({ query: teamName });
    const teams = await jira.request(`/rest/teams/1.0/teams/find?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    for (const team of teams) {
      if (team.title === teamName) {
        return String(team.id);
      }
    }
  } catch (error) {
    console.warn(`Warning: team API lookup failed for "${teamName}": ${error.message}`);
  }

  return null;
}

async function resolveJiraAccountId(assignee, jira) {
  if (!assignee) {
    return null;
  }

  if (/^[0-9a-f]{8,}$/i.test(assignee) || assignee.includes(':')) {
    return assignee;
  }

  const users = await jira.searchUsers(assignee);
  const exactEmail = users.find((user) => user.emailAddress?.toLowerCase() === assignee.toLowerCase());
  if (exactEmail?.accountId) {
    return exactEmail.accountId;
  }

  const exactDisplayName = users.find((user) => user.displayName?.toLowerCase() === assignee.toLowerCase());
  if (exactDisplayName?.accountId) {
    return exactDisplayName.accountId;
  }

  if (users.length === 1 && users[0]?.accountId) {
    return users[0].accountId;
  }

  throw new Error(`Unable to resolve Jira assignee "${assignee}"`);
}

async function resolveSprintForDueDate(jira, projectKey, dueDate) {
  if (!dueDate) {
    return null;
  }

  const boards = await jira.getBoards(projectKey);
  const scrumBoards = boards.filter((board) => board.type === 'scrum');
  for (const board of scrumBoards) {
    const sprints = await jira.getBoardSprints(board.id);
    const sprint = findSprintForDate(sprints, dueDate);
    if (sprint) {
      return sprint;
    }
  }

  return null;
}

async function shouldAssignSprint(jira, issueKey, sprint) {
  if (!sprint) {
    return false;
  }

  const sprintField = await jira.findField('Sprint', { includeBuiltin: false });
  if (!sprintField) {
    console.warn('Warning: Jira field "Sprint" was not found, skipping sprint assignment');
    return false;
  }

  const issue = await jira.getIssue(issueKey, [sprintField.id]);
  const currentSprints = issue.fields?.[sprintField.id];
  if (Array.isArray(currentSprints) && currentSprints.some((item) => String(item.id) === String(sprint.id))) {
    return false;
  }

  return true;
}

async function ensureSprintAssignment(jira, issueKey, sprint) {
  if (!await shouldAssignSprint(jira, issueKey, sprint)) {
    return;
  }

  await jira.addIssueToSprint(sprint.id, issueKey);
}

async function formatFieldForWrite(fieldMeta, value, jira) {
  const fieldId = fieldMeta.id;
  const customType = fieldMeta.schema?.custom ?? '';
  const schemaType = fieldMeta.schema?.type ?? '';

  if (customType.includes('team') || customType.includes('teams')) {
    const teamId = await resolveTeamId(value, jira, fieldId);
    if (!teamId) {
      console.warn(`Warning: unable to resolve Jira team "${value}", skipping field ${fieldMeta.name}`);
      return null;
    }
    return { id: teamId };
  }

  if (schemaType === 'date' || schemaType === 'datetime') {
    return value;
  }

  if (fieldId.startsWith('customfield_')) {
    return { value };
  }

  return { name: value };
}

export function shouldPopulateConfiguredAssignee(existingIssue) {
  if (!existingIssue) {
    return true;
  }
  return !existingIssue.fields?.assignee;
}

async function buildJiraFields(config, jira, milestone, existingIssue, issues, scyllaFieldMeta) {
  const fields = {
    project: { key: config.jira.project },
    summary: buildExpectedSummary(config, milestone.title),
    issuetype: { name: config.jira.issueType },
    description: mergeJiraDescription(existingIssue?.fields?.description ?? null, {
      milestone,
      issues,
      fallbackText: stripGitHubManagedBlock(milestone.description ?? ''),
    }),
  };

  if (scyllaFieldMeta && config.jira.scyllaComponents) {
    fields[scyllaFieldMeta.id] = formatSelectValue(config.jira.scyllaComponents, scyllaFieldMeta.isMulti);
  }

  const milestoneStartDate = isoDateFromTimestamp(milestone.created_at);
  const milestoneDueDate = isoDateFromTimestamp(milestone.due_on);
  const deliveryQuarter = quarterLabelFromDate(milestoneDueDate);

  if (milestoneStartDate) {
    const startDateField = await jira.findField('Start date', { includeBuiltin: true, schemaType: 'date' });
    if (!startDateField) {
      throw new Error('Jira field "Start date" was not found.');
    }
    fields[startDateField.id] = milestoneStartDate;
  }

  if (milestoneDueDate) {
    const dueDateField = await jira.findField('Due date', { includeBuiltin: true, schemaType: 'date' });
    if (!dueDateField) {
      throw new Error('Jira field "Due date" was not found.');
    }
    fields[dueDateField.id] = milestoneDueDate;
  }

  if (deliveryQuarter) {
    const deliveryQuarterField = await jira.findField('Delivery Quarter', { includeBuiltin: false });
    if (!deliveryQuarterField) {
      throw new Error('Jira field "Delivery Quarter" was not found.');
    }
    fields[deliveryQuarterField.id] = { value: deliveryQuarter };
  }

  if (config.jira.assignee && shouldPopulateConfiguredAssignee(existingIssue)) {
    fields.assignee = { accountId: await resolveJiraAccountId(config.jira.assignee, jira) };
  }

  if (config.jira.team) {
    const teamField = await jira.findField('Team', { includeBuiltin: true });
    if (!teamField) {
      throw new Error('Jira field "Team" was not found.');
    }
    const formattedTeam = await formatFieldForWrite(teamField, config.jira.team, jira);
    if (formattedTeam !== null) {
      fields[teamField.id] = formattedTeam;
    }
  }

  return fields;
}

async function findExistingEpic(jira, config, milestone, expectedSummary) {
  const jiraKeyInMilestone = parseJiraKeyFromGitHubDescription(milestone.description ?? '');
  if (jiraKeyInMilestone) {
    try {
      return await jira.getIssue(jiraKeyInMilestone);
    } catch (error) {
      if (!String(error.message).includes('Jira API 404')) {
        throw error;
      }
    }
  }

  const search = await jira.searchIssues(
    `project = ${config.jira.project} AND issuetype = ${quoteJql(config.jira.issueType)} AND summary ~ ${quoteJql(expectedSummary)}`,
    ['summary', 'description'],
  );

  const exactMatches = (search.issues ?? []).filter((issue) => issue.fields?.summary === expectedSummary);
  if (exactMatches.length === 1) {
    return jira.getIssue(exactMatches[0].key);
  }
  if (exactMatches.length > 1) {
    const remoteLinkMatches = [];
    for (const issue of exactMatches) {
      const remoteLinks = await jira.getRemoteLinks(issue.key);
      if (remoteLinks.some((item) => item?.object?.url === milestone.html_url)) {
        remoteLinkMatches.push(issue);
      }
    }
    if (remoteLinkMatches.length === 1) {
      return jira.getIssue(remoteLinkMatches[0].key);
    }
    throw new Error(`Multiple Jira issues matched summary "${expectedSummary}". Add a Jira link to the milestone description to disambiguate.`);
  }
  return null;
}

async function ensureJiraRemoteLink(jira, issueKey, milestone, githubRepo) {
  const title = `GitHub milestone: ${githubRepo.owner}/${githubRepo.repo} / ${milestone.title}`;
  await jira.addRemoteLink(issueKey, milestone.html_url, title);
}

async function hasJiraRemoteLink(jira, issueKey, milestoneUrl) {
  const remoteLinks = await jira.getRemoteLinks(issueKey);
  return remoteLinks.some((item) => item?.object?.url === milestoneUrl);
}

function shouldUpdateGitHubMilestoneLink(milestone, jiraKey, jiraBaseUrl) {
  const nextDescription = mergeGitHubDescription(milestone.description ?? '', jiraKey, `${jiraBaseUrl}/browse/${jiraKey}`);
  return (milestone.description ?? '') !== nextDescription;
}

async function ensureGitHubMilestoneLink(token, githubRepo, milestone, jiraKey, jiraBaseUrl) {
  const nextDescription = mergeGitHubDescription(milestone.description ?? '', jiraKey, `${jiraBaseUrl}/browse/${jiraKey}`);
  if ((milestone.description ?? '') === nextDescription) {
    return;
  }

  await githubRequest(
    token,
    `/repos/${githubRepo.owner}/${githubRepo.repo}/milestones/${milestone.number}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: nextDescription }),
    },
  );
}

function buildGitHubOnlyDryRunResult(config, milestone, issues) {
  const expectedSummary = buildExpectedSummary(config, milestone.title);
  const hasManagedLink = Boolean(extractGitHubManagedBlock(milestone.description ?? ''));
  const plannedActions = [
    `prepare Jira ${config.jira.issueType} summary "${expectedSummary}"`,
    `create-or-update Jira ${config.jira.issueType} in project ${config.jira.project}`,
    'skip Jira-specific lookups and field resolution in GitHub-only dry-run',
  ];

  if (!hasManagedLink) {
    plannedActions.push('update GitHub milestone description with Jira link');
  }

  return {
    jiraKey: null,
    milestoneNumber: milestone.number,
    milestoneTitle: milestone.title,
    issueCount: issues.length,
    action: 'would create-or-update',
    dryRun: true,
    plannedActions,
    githubOnlyDryRun: true,
  };
}

async function syncMilestone(config, milestoneSelector) {
  const githubToken = getGitHubToken();
  const githubRepo = getGitHubRepo();
  const dryRun = isDryRunEnabled();
  const githubOnlyDryRun = dryRun && isGitHubOnlyDryRunEnabled();

  const milestone = await resolveMilestone(
    githubToken,
    githubRepo.owner,
    githubRepo.repo,
    milestoneSelector,
  );
  const milestoneIssues = await listMilestoneIssues(
    githubToken,
    githubRepo.owner,
    githubRepo.repo,
    milestone.number,
  );
  const issues = await enrichMilestoneIssues(
    githubToken,
    githubRepo.owner,
    githubRepo.repo,
    milestoneIssues,
  );

  if (githubOnlyDryRun) {
    return buildGitHubOnlyDryRunResult(config, milestone, issues);
  }

  const jiraAuth = getJiraAuth();
  const jira = new JiraClient(config.jira.url, jiraAuth.user, jiraAuth.token);
  const expectedSummary = buildExpectedSummary(config, milestone.title);
  const scyllaFieldMeta = await ensureScyllaComponentsOption(config, jira);
  const milestoneDueDate = isoDateFromTimestamp(milestone.due_on);
  const sprint = await resolveSprintForDueDate(jira, config.jira.project, milestoneDueDate);
  const existingEpic = await findExistingEpic(jira, config, milestone, expectedSummary);
  const jiraFields = await buildJiraFields(
    config,
    jira,
    milestone,
    existingEpic,
    issues,
    scyllaFieldMeta,
  );

  let jiraKey = null;
  let action;
  const plannedActions = [];
  if (existingEpic) {
    jiraKey = existingEpic.key;
    const updateFields = { ...jiraFields };
    delete updateFields.project;
    delete updateFields.issuetype;
    if (dryRun) {
      action = 'would update';
      plannedActions.push(`update Jira issue ${jiraKey}`);
    } else {
      await jira.updateIssue(jiraKey, updateFields);
      action = 'updated';
    }
  } else {
    if (dryRun) {
      action = 'would create';
      plannedActions.push(`create Jira ${config.jira.issueType} in project ${config.jira.project}`);
    } else {
      const created = await jira.createIssue(jiraFields);
      jiraKey = created.key;
      action = 'created';
    }
  }

  if (dryRun) {
    if (sprint && (!existingEpic || await shouldAssignSprint(jira, jiraKey, sprint))) {
      plannedActions.push(`assign Jira issue to sprint ${sprint.name ?? sprint.id}`);
    }
    if (!existingEpic || !await hasJiraRemoteLink(jira, jiraKey, milestone.html_url)) {
      plannedActions.push(`add Jira remote link to ${milestone.html_url}`);
    }
    if (existingEpic) {
      if (shouldUpdateGitHubMilestoneLink(milestone, jiraKey, config.jira.url)) {
        plannedActions.push(`update GitHub milestone description with Jira link ${jiraKey}`);
      }
    } else {
      plannedActions.push('update GitHub milestone description with the created Jira link');
    }
  } else {
    await ensureSprintAssignment(jira, jiraKey, sprint);
    await ensureJiraRemoteLink(jira, jiraKey, milestone, githubRepo);
    await ensureGitHubMilestoneLink(githubToken, githubRepo, milestone, jiraKey, config.jira.url);
  }

  return {
    jiraKey,
    milestoneNumber: milestone.number,
    milestoneTitle: milestone.title,
    issueCount: issues.length,
    action,
    dryRun,
    plannedActions,
  };
}

async function syncMilestonesFromGitHubEvent(config, options = {}) {
  const eventName = getGitHubEventName(process.env, options.eventName);
  const eventPath = getGitHubEventPath(process.env, options.eventPath);
  const eventPayload = await readGitHubEventPayload(eventPath);
  const selectors = resolveMilestoneSelectorsFromGitHubEvent(eventName, eventPayload);

  if (selectors.length === 0) {
    return {
      eventName,
      action: String(eventPayload?.action ?? '').trim() || null,
      results: [],
    };
  }

  const results = [];
  for (const selector of selectors) {
    results.push(await syncMilestone(config, selector));
  }

  return {
    eventName,
    action: String(eventPayload?.action ?? '').trim() || null,
    results,
  };
}

async function showConfig(configPath) {
  const config = await readConfig(configPath);
  let github;
  let githubError = null;
  try {
    github = getGitHubRepo();
  } catch (error) {
    githubError = error.message;
  }
  console.log(JSON.stringify({
    configPath: path.resolve(configPath),
    github: github ?? null,
    jira: {
      ...config.jira,
      auth: {
        githubToken: Boolean(process.env.GITHUB_TOKEN || process.env.GH_TOKEN),
        githubRepositoryEnv: Boolean(process.env.GITHUB_REPOSITORY),
        gitFallbackAvailable: Boolean(findNearestGitRoot()),
        jiraAutomationEnv: Boolean(process.env.USER_AND_KEY_FOR_JIRA_AUTOMATION),
      },
    },
    ...(githubError ? { githubError } : {}),
  }, null, 2));
}

export function formatSyncResultLine(result) {
  const prefix = result.dryRun ? 'dry-run: ' : '';
  const jiraTarget = result.jiraKey
    ? `Jira ${result.jiraKey}`
    : `Jira ${result.dryRun ? 'issue' : 'unknown issue'}`;
  return `${prefix}${result.action} ${jiraTarget} from milestone #${result.milestoneNumber} (${result.milestoneTitle}); synced ${result.issueCount} issues.`;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.dryRun) {
      process.env.MILESTONE_SYNC_INTERNAL_DRY_RUN = '1';
    }
    const config = await readConfig(args.config);

    if (args.command === 'show-config') {
      await showConfig(args.config);
      return;
    }

    if (args.command === 'sync-event') {
      const eventResult = await syncMilestonesFromGitHubEvent(config, {
        eventName: args.eventName,
        eventPath: args.eventPath,
      });
      if (eventResult.results.length === 0) {
        const actionSuffix = eventResult.action ? `/${eventResult.action}` : '';
        console.log(`No milestone sync needed for GitHub event ${eventResult.eventName}${actionSuffix}.`);
        return;
      }
      for (const result of eventResult.results) {
        console.log(formatSyncResultLine(result));
        if (result.dryRun) {
          for (const plannedAction of result.plannedActions) {
            console.log(`  - ${plannedAction}`);
          }
        }
      }
      return;
    }

    const result = await syncMilestone(config, args.milestone);
    console.log(formatSyncResultLine(result));
    if (result.dryRun) {
      for (const plannedAction of result.plannedActions) {
        console.log(`  - ${plannedAction}`);
      }
    }
  } catch (error) {
    console.error(error.message);
    console.error('');
    console.error(usage());
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
