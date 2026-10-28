import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import type { Config } from '../types';
import { ClickUpProvider, getBlockedByFromClickUpDependencies } from '../providers/clickup';
import { JiraProvider } from '../providers/jira';
import { LinearProvider, getBlockedByFromLinearRelations } from '../providers/linear';
import { AgendaProvider, getBlockedByFromAgendaRelations, mapAgendaJobStatus } from '../providers/agenda';
import { checkImplementationStillActive } from '../statusWatch';
import { buildConsultProviderConfig, buildNonCodeProviderConfig } from '../providerViews';
import { MondayProvider, getBlockedByFromMondayColumnValues, getTagsFromMondayColumnValues } from '../providers/monday';
import { NotionProvider } from '../providers/notion';
import { TrelloProvider } from '../providers/trello';
import { logger } from '../logger';

const baseClickUpConfig = {
  clickupApiKey: 'test-key',
  clickupTeamId: 'team1',
  clickupTag: 'aidev',
  assigneeTag: '',
} as unknown as Config;

const baseJiraConfig = {
  jiraBaseUrl: 'https://example.atlassian.net',
  jiraEmail: 'test@example.com',
  jiraApiToken: 'token',
  jiraProject: 'PROJ',
  jiraLabel: 'aidev',
  assigneeTag: '',
} as unknown as Config;

const baseLinearConfig = {
  linearApiKey: 'lin_api_test',
  linearTeamId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  linearLabel: 'aidev',
  linearPendingStatus: 'Backlog',
  linearInReviewStatus: 'In Review',
  assigneeTag: '',
} as unknown as Config;

const baseMondayConfig = {
  mondayApiToken: 'test-token',
  mondayBoardId: '12345',
  mondayStatusColumnId: 'status',
  mondayGroupId: 'topics',
  clickupPendingStatus: 'Working on it',
  clickupInReviewStatus: 'Done',
} as unknown as Config;

const baseNotionConfig = {
  notionApiKey: 'test-notion-key',
  notionDatabaseId: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  notionStatusProperty: 'Status',
  notionPendingStatus: 'pending',
  notionInReviewStatus: 'review',
} as unknown as Config;

const baseTrelloConfig = {
  trelloApiKey: 'trello-key',
  trelloToken: 'trello-token',
  trelloBoardId: 'board1',
  trelloLabel: 'aidev',
  trelloOpenList: 'To Do',
  trelloPendingList: 'Blocked',
  trelloInProgressList: 'Doing',
  trelloInReviewList: 'In Review',
  trelloOpenStatus: 'open',
  trelloPendingStatus: 'pending',
  trelloInReviewStatus: 'review',
} as unknown as Config;

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body),
    json: async () => body,
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

function binaryResponse(text: string) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => text,
    json: async () => ({ text }),
    arrayBuffer: async () => Buffer.from(text),
  };
}

function mockFetch(body: unknown) {
  mock.method(globalThis, 'fetch', async () => jsonResponse(body));
}

function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const previous = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-provider-test-'));
  process.chdir(tmpDir);

  return fn(tmpDir).finally(() => {
    process.chdir(previous);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
}

function mockJiraCommentsFetch(comments: unknown, attachments: unknown[] = []) {
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('?fields=attachment')) {
      return jsonResponse({ fields: { attachment: attachments } });
    }
    return jsonResponse({ comments });
  });
}

// ─── ClickUpProvider.getComments ─────────────────────────────────────────────

describe('ClickUpProvider.fetchTasks', () => {
  afterEach(() => mock.restoreAll());

  it('downloads task attachments and appends local asset paths to the description', async () => {
    await withTempCwd(async (cwd) => {
      mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/team/team1/task')) {
          return jsonResponse({
            tasks: [
              {
                id: 'task1',
                name: 'Task with file',
                description: 'Handle the attached screenshot.',
                status: { status: 'open' },
                priority: { id: '1' },
                url: 'https://app.clickup.com/t/task1',
                tags: [{ name: 'aidev' }],
              },
            ],
          });
        }
        if (url.endsWith('/task/task1')) {
          return jsonResponse({
            attachments: [
              {
                id: 'att1',
                title: 'Screenshot 1.png',
                url: 'https://files.example/screenshot.png',
              },
            ],
          });
        }
        assert.equal(init?.headers instanceof Object ? (init.headers as Record<string, string>).Authorization : undefined, 'test-key');
        return binaryResponse('image-bytes');
      });

      const provider = new ClickUpProvider(baseClickUpConfig);
      const tasks = await provider.fetchTasks();

      assert.equal(tasks.length, 1);
      assert.match(tasks[0].description, /Local asset files/);
      assert.match(tasks[0].description, /\.aidev\/assets\/task1\/att1-Screenshot-1\.png/);
      assert.ok(fs.existsSync(path.join(cwd, '.aidev', 'assets', 'task1', 'att1-Screenshot-1.png')));
    });
  });
});

describe('ClickUpProvider.fetchBoardTasks', () => {
  afterEach(() => mock.restoreAll());

  it('uses one team list call and does not download attachments', async () => {
    let taskListCalls = 0;
    let taskDetailCalls = 0;
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/team/team1/task')) {
        taskListCalls += 1;
        return jsonResponse({
          tasks: [
            {
              id: 'open1',
              name: 'Open task',
              markdown_description: 'Long body',
              status: { status: 'open' },
              priority: null,
              url: 'https://app.clickup.com/t/open1',
              tags: [],
            },
            {
              id: 'prog1',
              name: 'In progress task',
              markdown_description: 'Also long',
              status: { status: 'in progress' },
              priority: null,
              url: 'https://app.clickup.com/t/prog1',
              tags: [],
            },
          ],
        });
      }
      if (url.includes('/task/')) {
        taskDetailCalls += 1;
      }
      return jsonResponse({});
    });

    const provider = new ClickUpProvider(baseClickUpConfig);
    const tasks = await provider.fetchBoardTasks();

    assert.equal(taskListCalls, 1);
    assert.equal(taskDetailCalls, 0);
    assert.equal(tasks.length, 2);
    assert.equal(tasks.find((t) => t.id === 'prog1')?.description, '');
    assert.equal(tasks.find((t) => t.id === 'open1')?.description, '');
  });
});

describe('ClickUpProvider.fetchTasksByStatus — includeClosed', () => {
  afterEach(() => mock.restoreAll());

  it('passes include_closed=true when includeClosed option is set', async () => {
    const seenUrls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      seenUrls.push(String(input));
      return jsonResponse({
        tasks: [
          {
            id: 'done1',
            name: 'Closed task',
            status: { status: 'closed' },
            priority: null,
            url: 'https://app.clickup.com/t/done1',
            tags: [{ name: 'aidev' }],
          },
        ],
      });
    });

    const provider = new ClickUpProvider(baseClickUpConfig);
    const tasks = await provider.fetchTasksByStatus(['closed'], { includeClosed: true });

    assert.equal(tasks.length, 1);
    assert.ok(seenUrls.some((u) => u.includes('include_closed=true')));
  });
});

describe('ClickUpProvider.fetchDashboardCounts', () => {
  afterEach(() => mock.restoreAll());

  it('uses three parallel lite queries and counts by status/date', async () => {
    const seenUrls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes('/team/team1/task') && url.includes('include_closed=false')) {
        return jsonResponse({
          last_page: true,
          tasks: [
            { id: 'o1', status: { status: 'open' }, date_updated: '1000' },
            { id: 'p1', status: { status: 'pending' }, date_updated: '1000' },
            { id: 'r1', status: { status: 'review' }, date_updated: '1000' },
          ],
        });
      }
      if (url.includes('date_updated_gt=500')) {
        return jsonResponse({
          last_page: true,
          tasks: [
            { id: 'e1', status: { status: 'review' }, date_updated: '800' },
            { id: 'e2', status: { status: 'closed' }, date_updated: '600' },
          ],
        });
      }
      if (url.includes('statuses[]=closed')) {
        return jsonResponse({
          last_page: true,
          tasks: [
            { id: 'd1', status: { status: 'closed' }, date_updated: '1000' },
            { id: 'd2', status: { status: 'closed' }, date_updated: '1000' },
          ],
        });
      }
      return jsonResponse({ last_page: true, tasks: [] });
    });

    const provider = new ClickUpProvider({
      ...baseClickUpConfig,
      clickupPendingStatus: 'pending',
      clickupOpenStatus: 'open',
      clickupInReviewStatus: 'review',
    } as unknown as Config);

    const counts = await provider.fetchDashboardCounts({
      openStatuses: ['open'],
      pendingStatuses: ['pending'],
      reviewStatuses: ['review'],
      inProgressStatuses: ['in progress'],
      doneStatuses: ['closed'],
      currentPeriodStart: 700,
      previousPeriodStart: 500,
    });

    assert.equal(counts.open, 1);
    assert.equal(counts.pending, 1);
    assert.equal(counts.inReview, 1);
    assert.equal(counts.allTimeDone, 2);
    assert.equal(counts.executedCurrent, 1);
    assert.equal(counts.executedPrevious, 1);
    assert.equal(seenUrls.filter((u) => u.includes('/team/team1/task')).length, 3);
    assert.ok(seenUrls.every((u) => !u.includes('include_markdown_description')));
  });
});

describe('ClickUpProvider.fetchTasks — wildcard tag', () => {
  afterEach(() => mock.restoreAll());

  it('omits tag filter from API call when tag is "*"', async () => {
    await withTempCwd(async () => {
      let capturedUrl = '';
      mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/team/team1/task')) {
          capturedUrl = url;
          return jsonResponse({
            tasks: [
              {
                id: 'task1',
                name: 'Any-tag task',
                description: 'No specific tag required.',
                status: { status: 'open' },
                priority: { id: '1' },
                url: 'https://app.clickup.com/t/task1',
                tags: [{ name: 'random' }],
              },
            ],
          });
        }
        if (url.endsWith('/task/task1')) {
          return jsonResponse({ attachments: [] });
        }
        return jsonResponse({});
      });

      const provider = new ClickUpProvider({
        ...baseClickUpConfig,
        clickupTag: '*',
      } as unknown as Config);
      const tasks = await provider.fetchTasks();

      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].name, 'Any-tag task');
      // The URL should NOT contain a tags[] parameter
      assert.ok(!capturedUrl.includes('tags%5B%5D'), 'should omit tags[] filter when tag is "*"');
      assert.ok(!capturedUrl.includes('tags[]='), 'should omit tags[] filter when tag is "*"');
    });
  });
});

describe('ClickUpProvider.getComments', () => {
  afterEach(() => mock.restoreAll());

  it('sorts newest-first API response into oldest-first (ascending by date)', async () => {
    mockFetch({
      comments: [
        // ClickUp returns newest first
        { id: '3', comment_text: 'aidev-continue', comment: [], user: { username: 'user', id: 1 }, date: '3000' },
        { id: '2', comment_text: 'Some answer', comment: [], user: { username: 'user', id: 1 }, date: '2000' },
        { id: '1', comment_text: '[aidev] Clarification question', comment: [], user: { username: 'bot', id: 2 }, date: '1000' },
      ],
    });
    const provider = new ClickUpProvider(baseClickUpConfig);
    const comments = await provider.getComments('task1');
    assert.equal(comments[0].text, '[aidev] Clarification question'); // oldest first
    assert.equal(comments[2].text, 'aidev-continue');                  // newest last
  });

  it('uses comment_text when it is a plain string', async () => {
    mockFetch({
      comments: [
        { id: '1', comment_text: 'hello world', comment: [], user: { username: 'user', id: 1 }, date: '1000' },
      ],
    });
    const provider = new ClickUpProvider(baseClickUpConfig);
    const comments = await provider.getComments('task1');
    assert.equal(comments[0].text, 'hello world');
  });

  it('falls back to comment array when comment_text is empty (rich-text editor)', async () => {
    mockFetch({
      comments: [
        {
          id: '1',
          comment_text: '',
          comment: [
            { text: 'aidev-continue', attributes: {} },
            { text: '\n', attributes: { 'block-id': 'abc' } },
          ],
          user: { username: 'user', id: 1 },
          date: '1000',
        },
      ],
    });
    const provider = new ClickUpProvider(baseClickUpConfig);
    const comments = await provider.getComments('task1');
    assert.ok(comments[0].text.includes('aidev-continue'));
  });

  it('returns empty text when both comment_text and comment array are empty', async () => {
    mockFetch({
      comments: [
        { id: '1', comment_text: '', comment: [], user: { username: 'user', id: 1 }, date: '1000' },
      ],
    });
    const provider = new ClickUpProvider(baseClickUpConfig);
    const comments = await provider.getComments('task1');
    assert.equal(comments[0].text, '');
  });

  it('trigger word is detected when newest comment contains it (real-world ordering)', async () => {
    // Simulate ClickUp newest-first response: aidev-continue is newest (highest date)
    // but sits at index 0 in the API response. After sorting it must be last.
    mockFetch({
      comments: [
        { id: '5', comment_text: 'aidev-continue', comment: [], user: { username: 'david', id: 1 }, date: '5000' },
        { id: '4', comment_text: 'User answer here', comment: [], user: { username: 'david', id: 1 }, date: '4000' },
        { id: '3', comment_text: '[aidev] All AI runners failed.', comment: [], user: { username: 'bot', id: 2 }, date: '3000' },
        { id: '2', comment_text: '[aidev] Starting implementation', comment: [], user: { username: 'bot', id: 2 }, date: '2000' },
        { id: '1', comment_text: '[aidev] Clarification question', comment: [], user: { username: 'bot', id: 2 }, date: '1000' },
      ],
    });
    const provider = new ClickUpProvider(baseClickUpConfig);
    const comments = await provider.getComments('task1');
    const last = comments[comments.length - 1];
    assert.ok(last.text.toLowerCase().includes('aidev-continue'));
  });
});

// ─── getBlockedByFromClickUpDependencies ───────────────────────────────────────

describe('getBlockedByFromClickUpDependencies', () => {
  it('returns blocker ids only for type=1 rows owned by the task', () => {
    const blockedBy = getBlockedByFromClickUpDependencies('task1', [
      { task_id: 'task1', depends_on: 'blocker1', type: 1 },
      { task_id: 'blocked-task', depends_on: 'task1', type: 1 },
      { task_id: 'task1', depends_on: 'blocked-task', type: 2 },
      { task_id: 'other', type: 0 },
    ]);
    assert.deepEqual(blockedBy, ['blocker1']);
  });

  it('returns an empty array when dependencies are missing or empty', () => {
    assert.deepEqual(getBlockedByFromClickUpDependencies('task1', undefined), []);
    assert.deepEqual(getBlockedByFromClickUpDependencies('task1', []), []);
  });
});

// ─── ClickUpProvider.fetchTaskById — dependency / blockedBy mapping ──────────

describe('ClickUpProvider.fetchTaskById — blockedBy mapping', () => {
  afterEach(() => mock.restoreAll());

  function makeRawTask(
    id: string,
    dependencies?: Array<{ task_id: string; depends_on?: string; type: number }>,
  ) {
    return {
      id,
      name: 'Test task',
      description: 'desc',
      status: { status: 'open' },
      priority: null,
      url: `https://app.clickup.com/t/${id}`,
      tags: [],
      ...(dependencies !== undefined ? { dependencies } : {}),
    };
  }

  it('populates blockedBy from depends_on dependencies (type=1 waiting on)', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse(makeRawTask('task1', [
        { task_id: 'task1', depends_on: 'blocker1', type: 1 },
        { task_id: 'task1', depends_on: 'blocker2', type: 1 },
      ]))
    );
    const provider = new ClickUpProvider(baseClickUpConfig);
    const task = await provider.fetchTaskById('task1');
    assert.ok(task !== null);
    assert.deepEqual(task!.blockedBy, ['blocker1', 'blocker2']);
  });

  it('ignores dependencies without depends_on (blocking others, not blocked-by)', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse(makeRawTask('task1', [
        { task_id: 'other', type: 0 },
      ]))
    );
    const provider = new ClickUpProvider(baseClickUpConfig);
    const task = await provider.fetchTaskById('task1');
    assert.ok(task !== null);
    assert.equal(task!.blockedBy, undefined);
  });

  it('handles mixed waiting-on and blocking entries — only includes depends_on', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse(makeRawTask('task1', [
        { task_id: 'task1', depends_on: 'blocker1', type: 1 },
        { task_id: 'other', type: 0 },
      ]))
    );
    const provider = new ClickUpProvider(baseClickUpConfig);
    const task = await provider.fetchTaskById('task1');
    assert.ok(task !== null);
    assert.deepEqual(task!.blockedBy, ['blocker1']);
  });

  it('excludes type=2 (blocking) entries even when depends_on is set', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse(makeRawTask('task1', [
        { task_id: 'task1', depends_on: 'blocker1', type: 1 },
        { task_id: 'task1', depends_on: 'other-task', type: 2 },
      ]))
    );
    const provider = new ClickUpProvider(baseClickUpConfig);
    const task = await provider.fetchTaskById('task1');
    assert.ok(task !== null);
    assert.deepEqual(task!.blockedBy, ['blocker1']);
  });

  it('ignores inverse waiting-on entries for tasks this one blocks', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse(makeRawTask('task1', [
        { task_id: 'blocked-task', depends_on: 'task1', type: 1 },
        { task_id: 'task1', depends_on: 'blocked-task', type: 2 },
      ]))
    );
    const provider = new ClickUpProvider(baseClickUpConfig);
    const task = await provider.fetchTaskById('task1');
    assert.ok(task !== null);
    assert.equal(task!.blockedBy, undefined);
  });

  it('sets blockedBy to undefined when dependencies field is missing', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse(makeRawTask('task1'))
    );
    const provider = new ClickUpProvider(baseClickUpConfig);
    const task = await provider.fetchTaskById('task1');
    assert.ok(task !== null);
    assert.equal(task!.blockedBy, undefined);
  });

  it('sets blockedBy to undefined when dependencies array is empty', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse(makeRawTask('task1', []))
    );
    const provider = new ClickUpProvider(baseClickUpConfig);
    const task = await provider.fetchTaskById('task1');
    assert.ok(task !== null);
    assert.equal(task!.blockedBy, undefined);
  });

  it('returns null when the API call fails', async () => {
    mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'not found' }));
    const provider = new ClickUpProvider(baseClickUpConfig);
    const task = await provider.fetchTaskById('nonexistent');
    assert.equal(task, null);
  });
});

describe('ClickUpProvider.updateStatus', () => {
  afterEach(() => mock.restoreAll());

  it('resolves configured status against the task list using trim-aware matching', async () => {
    const putBodies: string[] = [];
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/task/task1') && init?.method !== 'PUT') {
        return jsonResponse({ list: { id: 'list1' } });
      }
      if (url.endsWith('/list/list1')) {
        return jsonResponse({
          statuses: [
            { status: 'review' },
            { status: 'closed ' },
          ],
        });
      }
      if (url.endsWith('/task/task1') && init?.method === 'PUT') {
        putBodies.push(String(init.body));
        return jsonResponse({});
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const provider = new ClickUpProvider({
      ...baseClickUpConfig,
      clickupListId: 'list1',
    } as unknown as Config);
    await provider.updateStatus('task1', 'closed');

    assert.equal(putBodies.length, 1);
    assert.deepEqual(JSON.parse(putBodies[0]!), { status: 'closed ' });
  });

  it('surfaces ClickUp API error bodies instead of a generic request failure', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/task/task1') && init?.method !== 'PUT') {
        return jsonResponse({ list: { id: 'list1' } });
      }
      if (url.endsWith('/list/list1')) {
        return jsonResponse({ statuses: [{ status: 'review' }] });
      }
      if (url.endsWith('/task/task1') && init?.method === 'PUT') {
        return {
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: async () => '{"err":"Status does not exist","ECODE":"ITEM_114"}',
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const provider = new ClickUpProvider({
      ...baseClickUpConfig,
      clickupListId: 'list1',
    } as unknown as Config);

    await assert.rejects(
      () => provider.updateStatus('task1', 'review'),
      /ClickUp API error 400: \{"err":"Status does not exist","ECODE":"ITEM_114"\}/,
    );
  });
});

// ─── JiraProvider.getComments ─────────────────────────────────────────────────

describe('JiraProvider.getComments', () => {
  afterEach(() => mock.restoreAll());

  function adfComment(text: string) {
    return {
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    };
  }

  it('extracts plain text from ADF body', async () => {
    mockJiraCommentsFetch([
      { id: '1', body: adfComment('hello world'), author: { displayName: 'Alice', accountId: 'a1' }, created: '2024-01-01T10:00:00.000Z' },
    ]);
    const provider = new JiraProvider(baseJiraConfig);
    const comments = await provider.getComments('PROJ-1');
    assert.equal(comments[0].text, 'hello world');
  });

  it('sorts out-of-order API response into ascending date order', async () => {
    mockJiraCommentsFetch([
      { id: '3', body: adfComment('aidev-continue'), author: { displayName: 'Alice', accountId: 'a1' }, created: '2024-01-01T12:00:00.000Z' },
      { id: '1', body: adfComment('[aidev] Starting'), author: { displayName: 'bot', accountId: 'b1' }, created: '2024-01-01T10:00:00.000Z' },
      { id: '2', body: adfComment('User reply'), author: { displayName: 'Alice', accountId: 'a1' }, created: '2024-01-01T11:00:00.000Z' },
    ]);
    const provider = new JiraProvider(baseJiraConfig);
    const comments = await provider.getComments('PROJ-1');
    assert.equal(comments[0].text, '[aidev] Starting');  // oldest first
    assert.equal(comments[2].text, 'aidev-continue');     // newest last
  });

  it('trigger word is detected when newest comment contains it', async () => {
    mockJiraCommentsFetch([
      { id: '1', body: adfComment('[aidev] Clarification needed'), author: { displayName: 'bot', accountId: 'b1' }, created: '2024-01-01T10:00:00.000Z' },
      { id: '2', body: adfComment('aidev-continue'), author: { displayName: 'Alice', accountId: 'a1' }, created: '2024-01-01T11:00:00.000Z' },
    ]);
    const provider = new JiraProvider(baseJiraConfig);
    const comments = await provider.getComments('PROJ-1');
    const last = comments[comments.length - 1];
    assert.ok(last.text.toLowerCase().includes('aidev-continue'));
  });

  it('appends local asset paths when a comment links a native Jira attachment', async () => {
    await withTempCwd(async (cwd) => {
      mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('?fields=attachment')) {
          return jsonResponse({
            fields: {
              attachment: [
                {
                  id: '101',
                  filename: 'trace.json',
                  content: 'https://example.atlassian.net/rest/api/3/attachment/content/101',
                },
              ],
            },
          });
        }
        if (url.endsWith('/comment')) {
          return jsonResponse({
            comments: [
              {
                id: '1',
                body: {
                  type: 'doc',
                  version: 1,
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Please inspect ' },
                        {
                          type: 'text',
                          text: 'the trace',
                          marks: [
                            {
                              type: 'link',
                              attrs: {
                                href: 'https://example.atlassian.net/rest/api/3/attachment/content/101',
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
                author: { displayName: 'Alice', accountId: 'a1' },
                created: '2024-01-01T10:00:00.000Z',
              },
            ],
          });
        }
        return binaryResponse('{"trace":true}');
      });

      const provider = new JiraProvider(baseJiraConfig);
      const comments = await provider.getComments('PROJ-1');

      assert.match(comments[0].text, /Local asset files referenced by this comment/);
      assert.match(comments[0].text, /\.aidev\/assets\/PROJ-1\/101-trace\.json/);
      assert.ok(fs.existsSync(path.join(cwd, '.aidev', 'assets', 'PROJ-1', '101-trace.json')));
    });
  });
});

describe('JiraProvider.fetchTasks — wildcard label', () => {
  afterEach(() => mock.restoreAll());

  it('omits label clause from JQL when label is "*"', async () => {
    await withTempCwd(async () => {
      let capturedUrl = '';
      mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/search/jql')) {
          capturedUrl = url;
          return jsonResponse({
            issues: [
              {
                id: '2001',
                key: 'PROJ-5',
                fields: {
                  summary: 'Unlabelled task',
                  description: null,
                  status: { name: 'Open' },
                  priority: { id: '3' },
                  labels: [],
                  self: 'https://example.atlassian.net/rest/api/3/issue/2001',
                  attachment: [],
                },
              },
            ],
          });
        }
        return jsonResponse({});
      });

      const provider = new JiraProvider({
        ...baseJiraConfig,
        jiraLabel: '*',
      } as unknown as Config);
      const tasks = await provider.fetchTasks();

      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].id, 'PROJ-5');
      // JQL should NOT contain "AND labels =" clause
      const decodedUrl = decodeURIComponent(capturedUrl);
      assert.ok(!decodedUrl.includes('AND labels ='), 'should omit labels clause from JQL when label is "*"');
    });
  });
});

describe('JiraProvider.fetchTasks', () => {
  afterEach(() => mock.restoreAll());

  it('downloads issue attachments and appends local asset paths to the description', async () => {
    await withTempCwd(async (cwd) => {
      mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/search/jql')) {
          return jsonResponse({
            issues: [
              {
                id: '1001',
                key: 'PROJ-1',
                fields: {
                  summary: 'Handle uploaded trace',
                  description: {
                    type: 'doc',
                    version: 1,
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Review the trace file.' }] }],
                  },
                  status: { name: 'Open' },
                  priority: { id: '2' },
                  labels: ['aidev'],
                  self: 'https://example.atlassian.net/rest/api/3/issue/1001',
                  attachment: [
                    {
                      id: '101',
                      filename: 'trace.json',
                      content: 'https://example.atlassian.net/rest/api/3/attachment/content/101',
                    },
                  ],
                },
              },
            ],
          });
        }
        return binaryResponse('{"trace":true}');
      });

      const provider = new JiraProvider(baseJiraConfig);
      const tasks = await provider.fetchTasks();

      assert.equal(tasks.length, 1);
      assert.match(tasks[0].description, /Local asset files/);
      assert.match(tasks[0].description, /\.aidev\/assets\/PROJ-1\/101-trace\.json/);
      assert.ok(fs.existsSync(path.join(cwd, '.aidev', 'assets', 'PROJ-1', '101-trace.json')));
    });
  });
});

// ─── JiraProvider blocked-by ─────────────────────────────────────────────────

describe('JiraProvider.fetchTasks — blockedBy', () => {
  afterEach(() => mock.restoreAll());

  it('populates blockedBy from issuelinks where type.inward is "is blocked by"', async () => {
    await withTempCwd(async () => {
      mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/search/jql')) {
          return jsonResponse({
            issues: [
              {
                id: '1001',
                key: 'PROJ-1',
                fields: {
                  summary: 'Blocked task',
                  description: null,
                  status: { name: 'Open' },
                  priority: null,
                  labels: [],
                  attachment: [],
                  issuelinks: [
                    {
                      type: { inward: 'is blocked by', outward: 'blocks' },
                      inwardIssue: { key: 'PROJ-2' },
                    },
                    {
                      type: { inward: 'is blocked by', outward: 'blocks' },
                      inwardIssue: { key: 'PROJ-3' },
                    },
                    {
                      type: { inward: 'blocks', outward: 'is blocked by' },
                      outwardIssue: { key: 'PROJ-4' },
                    },
                  ],
                },
              },
            ],
          });
        }
        return jsonResponse({});
      });

      const provider = new JiraProvider(baseJiraConfig);
      const tasks = await provider.fetchTasks({ skipAttachments: true });

      assert.deepEqual(tasks[0].blockedBy, ['PROJ-2', 'PROJ-3']);
    });
  });

  it('leaves blockedBy undefined when issuelinks is empty', async () => {
    await withTempCwd(async () => {
      mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/search/jql')) {
          return jsonResponse({
            issues: [
              {
                id: '1001',
                key: 'PROJ-1',
                fields: {
                  summary: 'Unblocked task',
                  description: null,
                  status: { name: 'Open' },
                  priority: null,
                  labels: [],
                  attachment: [],
                  issuelinks: [],
                },
              },
            ],
          });
        }
        return jsonResponse({});
      });

      const provider = new JiraProvider(baseJiraConfig);
      const tasks = await provider.fetchTasks({ skipAttachments: true });

      assert.equal(tasks[0].blockedBy, undefined);
    });
  });
});

describe('JiraProvider.fetchTaskById', () => {
  afterEach(() => mock.restoreAll());

  it('returns a mapped Task with blockedBy when issue has blocking links', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse({
        key: 'PROJ-5',
        fields: {
          summary: 'A blocked issue',
          description: null,
          status: { name: 'In Progress' },
          priority: { id: '2' },
          labels: ['aidev'],
          project: { key: 'PROJ' },
          issuelinks: [
            {
              type: { inward: 'is blocked by', outward: 'blocks' },
              inwardIssue: { key: 'PROJ-10' },
            },
          ],
        },
      })
    );

    const provider = new JiraProvider(baseJiraConfig);
    const task = await provider.fetchTaskById!('PROJ-5');

    assert.ok(task !== null);
    assert.equal(task!.id, 'PROJ-5');
    assert.equal(task!.status, 'in progress');
    assert.deepEqual(task!.blockedBy, ['PROJ-10']);
  });

  it('returns null when the API returns an error', async () => {
    mock.method(globalThis, 'fetch', async () =>
      new Response('Not Found', { status: 404 })
    );

    const provider = new JiraProvider(baseJiraConfig);
    const task = await provider.fetchTaskById!('PROJ-MISSING');

    assert.equal(task, null);
  });
});

// ─── LinearProvider ─────────────────────────────────────────────────────────

describe('LinearProvider.fetchTasks — wildcard label', () => {
  afterEach(() => mock.restoreAll());

  it('omits label filter from GraphQL query when label is "*"', async () => {
    let capturedFilter: Record<string, unknown> = {};
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.query?.includes('workflowStates')) {
        return jsonResponse({
          data: { workflowStates: { nodes: [{ id: 's1', name: 'Backlog', type: 'unstarted' }] } },
        });
      }
      if (body.query?.includes('issues')) {
        capturedFilter = body.variables?.filter || {};
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-2',
                  identifier: 'ENG-99',
                  title: 'No label task',
                  description: 'Should appear without label filter.',
                  url: 'https://linear.app/org/issue/ENG-99',
                  state: { id: 's1', name: 'Backlog', type: 'unstarted' },
                  priority: 1,
                  labels: { nodes: [] },
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider({
      ...baseLinearConfig,
      linearLabel: '*',
    } as unknown as Config);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'ENG-99');
    // Filter should NOT contain a labels key
    assert.equal(capturedFilter.labels, undefined, 'should not include labels filter when label is "*"');
  });
});

describe('LinearProvider.fetchTasks', () => {
  afterEach(() => mock.restoreAll());

  it('returns issues with identifier as id and state name as status', async () => {
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.query?.includes('workflowStates')) {
        return jsonResponse({
          data: { workflowStates: { nodes: [{ id: 's1', name: 'Backlog', type: 'unstarted' }, { id: 's2', name: 'In Review', type: 'started' }] } },
        });
      }
      if (body.query?.includes('issues')) {
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-42',
                  title: 'Fix login',
                  description: 'Fix the login flow.',
                  url: 'https://linear.app/org/issue/ENG-42',
                  state: { id: 's1', name: 'Backlog', type: 'unstarted' },
                  priority: 2,
                  labels: { nodes: [{ name: 'aidev' }] },
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'ENG-42');
    assert.equal(tasks[0].name, 'Fix login');
    assert.equal(tasks[0].description, 'Fix the login flow.');
    assert.equal(tasks[0].status, 'Backlog');
    assert.equal(tasks[0].url, 'https://linear.app/org/issue/ENG-42');
    assert.deepEqual(tasks[0].tags, ['aidev']);
    assert.equal(tasks[0].priority, 2);
  });
});

describe('LinearProvider.fetchTasks — blockedBy', () => {
  afterEach(() => mock.restoreAll());

  it('populates blockedBy from inverseRelations of type "blocks"', async () => {
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.query?.includes('issues')) {
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-1',
                  identifier: 'ENG-10',
                  title: 'Blocked task',
                  description: '',
                  url: 'https://linear.app/org/issue/ENG-10',
                  state: { id: 's1', name: 'Todo', type: 'unstarted' },
                  priority: null,
                  labels: { nodes: [] },
                  relations: {
                    nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ENG-99' } }],
                  },
                  inverseRelations: {
                    nodes: [{ type: 'blocks', issue: { identifier: 'ENG-5' } }],
                  },
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].blockedBy, ['ENG-5']);
  });

  it('supports legacy blocked relations on relations.nodes', () => {
    const blockedBy = getBlockedByFromLinearRelations(
      { nodes: [{ type: 'blocked', relatedIssue: { identifier: 'ENG-2' } }] },
      { nodes: [] },
    );
    assert.deepEqual(blockedBy, ['ENG-2']);
  });

  it('omits blockedBy when no blocking relations exist', async () => {
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.query?.includes('issues')) {
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-2',
                  identifier: 'ENG-11',
                  title: 'Unblocked task',
                  description: '',
                  url: 'https://linear.app/org/issue/ENG-11',
                  state: { id: 's1', name: 'Todo', type: 'unstarted' },
                  priority: null,
                  labels: { nodes: [] },
                  relations: { nodes: [] },
                  inverseRelations: { nodes: [] },
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].blockedBy, undefined);
  });
});

describe('LinearProvider.fetchTaskById', () => {
  afterEach(() => mock.restoreAll());

  it('returns a task mapped from a single-issue query', async () => {
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.query?.includes('IssueById')) {
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-5',
                  identifier: 'ENG-5',
                  title: 'Blocker issue',
                  description: 'Blocking something.',
                  url: 'https://linear.app/org/issue/ENG-5',
                  state: { id: 's2', name: 'In Progress', type: 'started' },
                  priority: 1,
                  labels: { nodes: [] },
                  relations: { nodes: [] },
                  inverseRelations: { nodes: [] },
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    const task = await provider.fetchTaskById('ENG-5');

    assert.ok(task);
    assert.equal(task.id, 'ENG-5');
    assert.equal(task.name, 'Blocker issue');
    assert.equal(task.status, 'In Progress');
  });

  it('returns null when the issue is not found', async () => {
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.query?.includes('IssueById')) {
        return jsonResponse({ data: { issues: { nodes: [] } } });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    const task = await provider.fetchTaskById('ENG-999');

    assert.equal(task, null);
  });

  it('populates blockedBy on the fetched task', async () => {
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.query?.includes('IssueById')) {
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: 'issue-uuid-7',
                  identifier: 'ENG-7',
                  title: 'Blocked blocker',
                  description: '',
                  url: 'https://linear.app/org/issue/ENG-7',
                  state: { id: 's1', name: 'Todo', type: 'unstarted' },
                  priority: null,
                  labels: { nodes: [] },
                  relations: { nodes: [] },
                  inverseRelations: {
                    nodes: [{ type: 'blocks', issue: { identifier: 'ENG-3' } }],
                  },
                },
              ],
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    const task = await provider.fetchTaskById('ENG-7');

    assert.ok(task);
    assert.deepEqual(task.blockedBy, ['ENG-3']);
  });
});

describe('LinearProvider.getComments', () => {
  afterEach(() => mock.restoreAll());

  it('returns comments sorted ascending by date', async () => {
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      if (body.query?.includes('issues') && body.variables?.filter?.team?.key) {
        return jsonResponse({ data: { issues: { nodes: [{ id: 'issue-uuid-1' }] } } });
      }
      if (body.query?.includes('IssueComments') && body.variables?.issueId) {
        return jsonResponse({
          data: {
            comments: {
              nodes: [
                {
                  id: 'c1',
                  body: '[aidev] Starting',
                  parentId: null,
                  user: { name: 'Bot', id: 'u1' },
                  botActor: null,
                  externalUser: null,
                  createdAt: '2024-01-01T10:00:00.000Z',
                },
                {
                  id: 'c2',
                  body: 'aidev-continue',
                  parentId: null,
                  user: { name: 'Alice', id: 'u2' },
                  botActor: null,
                  externalUser: null,
                  createdAt: '2024-01-01T11:00:00.000Z',
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    const comments = await provider.getComments('ENG-42');

    assert.equal(comments.length, 2);
    assert.equal(comments[0].text, '[aidev] Starting');
    assert.equal(comments[1].text, 'aidev-continue');
    assert.equal(comments[1].author, 'Alice');
  });
});

describe('LinearProvider.createTask — labels', () => {
  afterEach(() => mock.restoreAll());

  it('resolves an existing label and creates a missing one, then attaches both ids', async () => {
    const labelCreateCalls: Array<Record<string, unknown>> = [];
    let issueCreateInput: Record<string, unknown> | undefined;

    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = body.query as string;
      if (query.includes('issueLabels')) {
        return jsonResponse({
          data: {
            issueLabels: {
              nodes: [{ id: 'label-existing-id', name: 'Backend' }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      if (query.includes('issueLabelCreate')) {
        labelCreateCalls.push(body.variables?.input ?? {});
        const name = (body.variables?.input as Record<string, unknown>)?.name as string;
        return jsonResponse({
          data: {
            issueLabelCreate: {
              success: true,
              issueLabel: { id: 'label-new-id', name },
            },
          },
        });
      }
      if (query.includes('issueCreate')) {
        issueCreateInput = body.variables?.input as Record<string, unknown>;
        return jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { id: 'issue-uuid', identifier: 'ENG-7', url: 'https://linear.app/org/issue/ENG-7' },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    const result = await provider.createTask({
      title: 'New task',
      description: 'desc',
      tags: ['backend', 'urgent'],
    });

    assert.equal(result.id, 'ENG-7');
    assert.equal(labelCreateCalls.length, 1, 'should issueLabelCreate exactly once');
    assert.equal((labelCreateCalls[0] as Record<string, unknown>).name, 'urgent');
    assert.equal((labelCreateCalls[0] as Record<string, unknown>).teamId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    assert.ok(issueCreateInput, 'issueCreate must have been called');
    assert.deepEqual(issueCreateInput!.labelIds, ['label-existing-id', 'label-new-id']);
  });

  it('paginates issueLabels and finds an existing label on a later page', async () => {
    const labelCreateCalls: Array<Record<string, unknown>> = [];
    let issueCreateInput: Record<string, unknown> | undefined;
    const cursors: Array<string | null> = [];

    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = body.query as string;
      if (query.includes('issueLabels')) {
        const after = (body.variables?.after as string | null) ?? null;
        cursors.push(after);
        if (after === null) {
          return jsonResponse({
            data: {
              issueLabels: {
                nodes: [{ id: 'label-page1', name: 'Frontend' }],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              },
            },
          });
        }
        return jsonResponse({
          data: {
            issueLabels: {
              nodes: [{ id: 'label-page2', name: 'Backend' }],
              pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
            },
          },
        });
      }
      if (query.includes('issueLabelCreate')) {
        labelCreateCalls.push(body.variables?.input ?? {});
        return jsonResponse({ data: { issueLabelCreate: { success: true, issueLabel: null } } });
      }
      if (query.includes('issueCreate')) {
        issueCreateInput = body.variables?.input as Record<string, unknown>;
        return jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { id: 'issue-uuid', identifier: 'ENG-11', url: 'https://linear.app/org/issue/ENG-11' },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    const result = await provider.createTask({
      title: 'Paginated label',
      description: '',
      tags: ['backend'],
    });

    assert.equal(result.id, 'ENG-11');
    assert.deepEqual(cursors, [null, 'cursor-1'], 'should walk pages until hasNextPage is false');
    assert.equal(labelCreateCalls.length, 0, 'should not create a label that exists on a later page');
    assert.ok(issueCreateInput, 'issueCreate must have been called');
    assert.deepEqual(issueCreateInput!.labelIds, ['label-page2']);
  });

  it('omits labelIds entirely when params.tags is empty', async () => {
    let issueLabelsCalled = false;
    let issueCreateInput: Record<string, unknown> | undefined;

    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = body.query as string;
      if (query.includes('issueLabels')) {
        issueLabelsCalled = true;
        return jsonResponse({ data: { issueLabels: { nodes: [] } } });
      }
      if (query.includes('issueCreate')) {
        issueCreateInput = body.variables?.input as Record<string, unknown>;
        return jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { id: 'issue-uuid', identifier: 'ENG-8', url: 'https://linear.app/org/issue/ENG-8' },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    await provider.createTask({ title: 'No tags', description: '', tags: [] });

    assert.equal(issueLabelsCalled, false, 'should not query labels when tags is empty');
    assert.ok(issueCreateInput, 'issueCreate must have been called');
    assert.equal('labelIds' in issueCreateInput!, false, 'input must not contain labelIds');
  });
});

describe('LinearProvider.updateStatus — state type fallback', () => {
  afterEach(() => mock.restoreAll());

  it('matches by Linear state type when no state name matches the configured status', async () => {
    let updatedStateId: string | undefined;

    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = body.query as string;
      if (query.includes('workflowStates')) {
        return jsonResponse({
          data: {
            workflowStates: {
              nodes: [
                { id: 'state-triage', name: 'Triage', type: 'backlog' },
                { id: 'state-doing', name: 'Doing', type: 'started' },
                { id: 'state-shipped', name: 'Shipped', type: 'completed' },
              ],
            },
          },
        });
      }
      if (query.includes('issues') && body.variables?.filter?.team?.key) {
        return jsonResponse({ data: { issues: { nodes: [{ id: 'issue-uuid-99' }] } } });
      }
      if (query.includes('issueUpdate')) {
        updatedStateId = (body.variables?.input as Record<string, unknown>)?.stateId as string;
        return jsonResponse({ data: { issueUpdate: { success: true } } });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    await provider.updateStatus('ENG-99', 'Backlog');

    assert.equal(updatedStateId, 'state-triage');
  });
});

describe('LinearProvider.createTask — assignee resolution', () => {
  afterEach(() => mock.restoreAll());

  it('extracts email from "username <email>" format and queries by email', async () => {
    const userFilters: Array<Record<string, unknown>> = [];
    let issueCreateInput: Record<string, unknown> | undefined;

    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = body.query as string;
      if (query.includes('users')) {
        userFilters.push((body.variables?.filter as Record<string, unknown>) ?? {});
        return jsonResponse({
          data: { users: { nodes: [{ id: 'user-uuid-1', email: 'alice@example.com', displayName: 'Alice' }] } },
        });
      }
      if (query.includes('issueCreate')) {
        issueCreateInput = body.variables?.input as Record<string, unknown>;
        return jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { id: 'issue-uuid', identifier: 'ENG-10', url: 'https://linear.app/org/issue/ENG-10' },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider({
      ...baseLinearConfig,
      assigneeTag: 'Alice <alice@example.com>',
    } as unknown as Config);
    const result = await provider.createTask({ title: 'Assigned', description: '', tags: [] });

    assert.equal(result.id, 'ENG-10');
    assert.ok(issueCreateInput, 'issueCreate must have been called');
    assert.equal(issueCreateInput!.assigneeId, 'user-uuid-1');
    assert.equal(userFilters.length, 1, 'should query users exactly once when email lookup succeeds');
    assert.deepEqual(userFilters[0], { email: { eq: 'alice@example.com' } });
  });

  it('warns and creates the issue without assignee when no user matches', async () => {
    let issueCreateInput: Record<string, unknown> | undefined;

    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = body.query as string;
      if (query.includes('users')) {
        return jsonResponse({ data: { users: { nodes: [] } } });
      }
      if (query.includes('issueCreate')) {
        issueCreateInput = body.variables?.input as Record<string, unknown>;
        return jsonResponse({
          data: {
            issueCreate: {
              success: true,
              issue: { id: 'issue-uuid', identifier: 'ENG-9', url: 'https://linear.app/org/issue/ENG-9' },
            },
          },
        });
      }
      return jsonResponse({ data: {} });
    });
    const warn = mock.method(logger, 'warn', () => {});

    const provider = new LinearProvider({
      ...baseLinearConfig,
      assigneeTag: 'unknown@example.com',
    } as unknown as Config);
    const result = await provider.createTask({ title: 'No assignee', description: '', tags: [] });

    assert.equal(result.id, 'ENG-9');
    assert.ok(issueCreateInput, 'issueCreate must have been called');
    assert.equal('assigneeId' in issueCreateInput!, false, 'input must not contain assigneeId');
    assert.ok(warn.mock.callCount() >= 1, 'logger.warn must be called at least once');
    const firstCallArg = warn.mock.calls[0]?.arguments?.[0] ?? '';
    assert.match(String(firstCallArg), /unknown@example\.com/);
  });
});

describe('ClickUpProvider.deleteTask', () => {
  afterEach(() => mock.restoreAll());

  it('sends a DELETE request to /task/{taskId}', async () => {
    let requestedUrl: string | undefined;
    let requestedMethod: string | undefined;

    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedMethod = init?.method;
      return jsonResponse({});
    });

    const provider = new ClickUpProvider(baseClickUpConfig);
    await provider.deleteTask!('task123');

    assert.equal(requestedMethod, 'DELETE');
    assert.match(requestedUrl!, /\/task\/task123$/);
  });

  it('throws a ClickUp API error on failure', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 404,
      text: async () => 'Not Found',
    }));

    const provider = new ClickUpProvider(baseClickUpConfig);
    await assert.rejects(
      () => provider.deleteTask!('missing-task'),
      /ClickUp API error 404: Not Found/,
    );
  });
});

describe('LinearProvider.deleteTask', () => {
  afterEach(() => mock.restoreAll());

  it('resolves the issue id and sends the issueDelete mutation', async () => {
    let deleteMutationVars: Record<string, unknown> | undefined;

    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const query = body.query as string;
      if (query.includes('issues') && body.variables?.filter?.team?.key) {
        return jsonResponse({ data: { issues: { nodes: [{ id: 'issue-uuid-99' }] } } });
      }
      if (query.includes('issueDelete')) {
        deleteMutationVars = body.variables as Record<string, unknown>;
        return jsonResponse({ data: { issueDelete: { success: true } } });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new LinearProvider(baseLinearConfig);
    await provider.deleteTask!('ENG-99');

    assert.deepEqual(deleteMutationVars, { id: 'issue-uuid-99' });
  });
});

// ─── MondayProvider ───────────────────────────────────────────────────────────

describe('MondayProvider.fetchTasks', () => {
  afterEach(() => mock.restoreAll());

  it('returns items whose status matches pending or in-review', async () => {
    mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof (init?.body) === 'string' ? JSON.parse(init.body) : {};
      const query = body.query as string;
      if (query.includes('boards') && query.includes('items_page')) {
        return jsonResponse({
          data: {
            boards: [
              {
                items_page: {
                  cursor: null,
                  items: [
                    {
                      id: '1001',
                      name: 'Task one',
                      url: 'https://example.monday.com/boards/12345/pulses/1001',
                      description: { description: 'Do something' },
                      column_values: [
                        { id: 'status', value: '{"label":"Working on it"}', text: 'Working on it' },
                      ],
                    },
                    {
                      id: '1002',
                      name: 'Task two',
                      url: 'https://example.monday.com/boards/12345/pulses/1002',
                      description: { description: '' },
                      column_values: [
                        { id: 'status', value: '{"label":"Done"}', text: 'Done' },
                      ],
                    },
                    {
                      id: '1003',
                      name: 'Task three',
                      url: '',
                      description: {},
                      column_values: [
                        { id: 'status', value: '{}', text: 'Stuck' },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        });
      }
      return jsonResponse({});
    });

    const provider = new MondayProvider(baseMondayConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, '1001');
    assert.equal(tasks[0].name, 'Task one');
    assert.equal(tasks[0].status, 'Working on it');
    assert.equal(tasks[1].id, '1002');
    assert.equal(tasks[1].status, 'Done');
  });
});

describe('MondayProvider.getComments', () => {
  afterEach(() => mock.restoreAll());

  it('returns updates sorted ascending by date', async () => {
    mock.method(globalThis, 'fetch', async () =>
      jsonResponse({
        data: {
          items: [
            {
              updates: [
                { id: 'u2', text_body: 'Newest', body: '<p>Newest</p>', created_at: '2024-01-02T12:00:00Z', creator: { id: 'u1', name: 'Alice' } },
                { id: 'u1', text_body: 'Oldest', body: '<p>Oldest</p>', created_at: '2024-01-01T10:00:00Z', creator: { id: 'u1', name: 'Alice' } },
              ],
            },
          ],
        },
      })
    );

    const provider = new MondayProvider(baseMondayConfig);
    const comments = await provider.getComments('1001');

    assert.equal(comments.length, 2);
    assert.equal(comments[0].text, 'Oldest');
    assert.equal(comments[1].text, 'Newest');
  });
});

// ─── NotionProvider ─────────────────────────────────────────────────────────

describe('NotionProvider.fetchTasks', () => {
  afterEach(() => mock.restoreAll());

  it('returns pages with pending or review status from database query', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/databases/') && url.includes('/query') === false && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
          properties: {
            Name: { type: 'title' },
            Status: { type: 'status' },
          },
        });
      }
      if (url.includes('/query')) {
        return jsonResponse({
          results: [
            {
              id: 'a1b2c3d4-e5f6-7890-1234-5678abcdef01',
              url: 'https://notion.so/a1b2c3d4e5f6789012345678abcdef01',
              properties: {
                Name: { title: [{ plain_text: 'Task one' }] },
                Status: { status: { name: 'pending' } },
                Description: { rich_text: [{ plain_text: 'Do something' }] },
              },
            },
            {
              id: 'a1b2c3d4-e5f6-7890-1234-5678abcdef02',
              url: 'https://notion.so/page-two',
              properties: {
                Name: { title: [{ plain_text: 'Task two' }] },
                Status: { status: { name: 'review' } },
              },
            },
          ],
          next_cursor: null,
          has_more: false,
        });
      }
      return jsonResponse({});
    });

    const provider = new NotionProvider(baseNotionConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, 'a1b2c3d4e5f6789012345678abcdef01');
    assert.equal(tasks[0].name, 'Task one');
    assert.equal(tasks[0].description, 'Do something');
    assert.equal(tasks[0].status, 'pending');
    assert.equal(tasks[0].url, 'https://notion.so/a1b2c3d4e5f6789012345678abcdef01');
    assert.equal(tasks[1].name, 'Task two');
    assert.equal(tasks[1].status, 'review');
  });
});

// ─── TrelloProvider ─────────────────────────────────────────────────────────

describe('TrelloProvider.fetchTasks', () => {
  afterEach(() => mock.restoreAll());

  it('returns cards assigned to token user with label in open or pending lists', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/members/me')) {
        return jsonResponse({ id: 'member-me' });
      }
      if (url.includes('/boards/board1/lists')) {
        return jsonResponse([
          { id: 'list-open', name: 'To Do' },
          { id: 'list-pending', name: 'Blocked' },
        ]);
      }
      if (url.includes('/boards/board1/cards')) {
        return jsonResponse([
          {
            id: 'card1',
            name: 'Do work',
            desc: 'Details',
            url: 'https://trello.com/c/abc/card1',
            idList: 'list-open',
            idMembers: ['member-me'],
            labels: [{ id: 'l1', name: 'aidev' }],
          },
          {
            id: 'card2',
            name: 'Wrong assignee',
            desc: '',
            url: 'https://trello.com/c/def/card2',
            idList: 'list-open',
            idMembers: ['other'],
            labels: [{ id: 'l1', name: 'aidev' }],
          },
          {
            id: 'card3',
            name: 'In Doing column',
            desc: '',
            url: 'https://trello.com/c/ghi/card3',
            idList: 'list-doing',
            idMembers: ['member-me'],
            labels: [{ id: 'l1', name: 'aidev' }],
          },
        ]);
      }
      if (url.includes('/cards/card1/attachments')) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    });

    const provider = new TrelloProvider(baseTrelloConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'card1');
    assert.equal(tasks[0].status, 'open');
    assert.deepEqual(tasks[0].tags, ['aidev']);
  });

  it('omits label filter when TRELLO_LABEL is *', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/members/me')) {
        return jsonResponse({ id: 'member-me' });
      }
      if (url.includes('/boards/board1/lists')) {
        return jsonResponse([
          { id: 'list-open', name: 'To Do' },
          { id: 'list-pending', name: 'Blocked' },
        ]);
      }
      if (url.includes('/boards/board1/cards')) {
        return jsonResponse([
          {
            id: 'card1',
            name: 'No label',
            desc: '',
            url: 'https://trello.com/c/abc/card1',
            idList: 'list-open',
            idMembers: ['member-me'],
            labels: [],
          },
        ]);
      }
      if (url.includes('/cards/card1/attachments')) {
        return jsonResponse([]);
      }
      return jsonResponse({});
    });

    const provider = new TrelloProvider({
      ...baseTrelloConfig,
      trelloLabel: '*',
    } as unknown as Config);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, 'No label');
  });
});

describe('TrelloProvider.getComments', () => {
  afterEach(() => mock.restoreAll());

  it('returns comment actions sorted ascending by date', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/cards/card1/actions')) {
        return jsonResponse([
          {
            id: 'a2',
            type: 'commentCard',
            date: '2024-01-02T12:00:00.000Z',
            data: { text: 'Newest' },
            idMemberCreator: 'u1',
            memberCreator: { id: 'u1', fullName: 'Alice', username: 'alice' },
          },
          {
            id: 'a1',
            type: 'commentCard',
            date: '2024-01-01T10:00:00.000Z',
            data: { text: 'Oldest' },
            idMemberCreator: 'u1',
            memberCreator: { id: 'u1', fullName: 'Alice', username: 'alice' },
          },
        ]);
      }
      return jsonResponse({});
    });

    const provider = new TrelloProvider(baseTrelloConfig);
    const comments = await provider.getComments('card1');

    assert.equal(comments.length, 2);
    assert.equal(comments[0].text, 'Oldest');
    assert.equal(comments[1].text, 'Newest');
  });
});

describe('TrelloProvider.updateStatus', () => {
  afterEach(() => mock.restoreAll());

  it('PUTs card with idList for in progress', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/boards/board1/lists')) {
        return jsonResponse([
          { id: 'list-todo', name: 'To Do' },
          { id: 'list-doing', name: 'Doing' },
        ]);
      }
      if (url.includes('/cards/card1') && init?.method === 'PUT') {
        assert.ok(url.includes('idList=list-doing'));
        return jsonResponse({ id: 'card1', idList: 'list-doing' });
      }
      return jsonResponse({});
    });

    const provider = new TrelloProvider(baseTrelloConfig);
    await provider.updateStatus('card1', 'in progress');
  });
});

describe('NotionProvider.getComments', () => {
  afterEach(() => mock.restoreAll());

  it('returns comments sorted ascending by date', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/comments')) {
        return jsonResponse({
          results: [
            { id: 'c2', created_time: '2024-01-02T12:00:00.000Z', created_by: { id: 'u1' }, rich_text: [{ plain_text: 'Newest' }] },
            { id: 'c1', created_time: '2024-01-01T10:00:00.000Z', created_by: { id: 'u1' }, rich_text: [{ plain_text: 'Oldest' }] },
          ],
          next_cursor: null,
          has_more: false,
        });
      }
      return jsonResponse({});
    });

    const provider = new NotionProvider(baseNotionConfig);
    const comments = await provider.getComments('a1b2c3d4e5f6789012345678abcdef01');

    assert.equal(comments.length, 2);
    assert.equal(comments[0].text, 'Oldest');
    assert.equal(comments[1].text, 'Newest');
  });
});

// ─── MondayProvider.fetchTasks — blockedBy ────────────────────────────────────

describe('MondayProvider.fetchTasks — blockedBy', () => {
  afterEach(() => mock.restoreAll());

  it('populates blockedBy from a dependency-type column', async () => {
    mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof (init?.body) === 'string' ? JSON.parse(init.body) : {};
      if ((body.query as string)?.includes('items_page')) {
        return jsonResponse({
          data: {
            boards: [{
              items_page: {
                cursor: null,
                items: [{
                  id: '2001',
                  name: 'Blocked item',
                  url: 'https://example.monday.com/boards/12345/pulses/2001',
                  description: { description: 'Some work' },
                  column_values: [
                    { id: 'status', type: 'status', value: '{"label":"Working on it"}', text: 'Working on it' },
                    { id: 'connect_boards', type: 'dependency', value: null, text: '', linked_item_ids: ['3001', '3002'] },
                  ],
                }],
              },
            }],
          },
        });
      }
      return jsonResponse({});
    });

    const provider = new MondayProvider(baseMondayConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].blockedBy, ['3001', '3002']);
  });

  it('falls back to legacy dependency value JSON when linked_item_ids is absent', () => {
    const blockedBy = getBlockedByFromMondayColumnValues([
      {
        id: 'dep',
        type: 'dependency',
        value: '{"linkedPulseIds":[{"linkedPulseId":3001},{"linkedPulseId":3002}]}',
      },
    ]);
    assert.deepEqual(blockedBy, ['3001', '3002']);
  });

  it('omits blockedBy when there is no dependency column', async () => {
    mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof (init?.body) === 'string' ? JSON.parse(init.body) : {};
      if ((body.query as string)?.includes('items_page')) {
        return jsonResponse({
          data: {
            boards: [{
              items_page: {
                cursor: null,
                items: [{
                  id: '2002',
                  name: 'Unblocked item',
                  url: 'https://example.monday.com/boards/12345/pulses/2002',
                  description: { description: '' },
                  column_values: [
                    { id: 'status', type: 'status', value: '{"label":"Working on it"}', text: 'Working on it' },
                  ],
                }],
              },
            }],
          },
        });
      }
      return jsonResponse({});
    });

    const provider = new MondayProvider(baseMondayConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].blockedBy, undefined);
  });
});

// ─── MondayProvider.fetchTaskById ────────────────────────────────────────────

describe('MondayProvider.fetchTaskById', () => {
  afterEach(() => mock.restoreAll());

  it('returns a mapped Task with correct id and status', async () => {
    mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof (init?.body) === 'string' ? JSON.parse(init.body) : {};
      if ((body.query as string)?.includes('items(ids')) {
        return jsonResponse({
          data: {
            items: [{
              id: '1001',
              name: 'My item',
              url: 'https://example.monday.com/boards/12345/pulses/1001',
              column_values: [
                { id: 'status', type: 'status', value: '{"label":"Working on it"}', text: 'Working on it' },
              ],
            }],
          },
        });
      }
      return jsonResponse({});
    });

    const provider = new MondayProvider(baseMondayConfig);
    const task = await provider.fetchTaskById('1001');

    assert.ok(task !== null);
    assert.equal(task!.id, '1001');
    assert.equal(task!.name, 'My item');
    assert.equal(task!.status, 'Working on it');
    assert.equal(task!.blockedBy, undefined);
  });

  it('populates blockedBy from a dependency-type column', async () => {
    mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof (init?.body) === 'string' ? JSON.parse(init.body) : {};
      if ((body.query as string)?.includes('items(ids')) {
        return jsonResponse({
          data: {
            items: [{
              id: '2001',
              name: 'Blocked item',
              url: 'https://example.monday.com/boards/12345/pulses/2001',
              column_values: [
                { id: 'status', type: 'status', value: '{"label":"Working on it"}', text: 'Working on it' },
                { id: 'dep_col', type: 'dependency', value: null, text: '', linked_item_ids: ['5555'] },
              ],
            }],
          },
        });
      }
      return jsonResponse({});
    });

    const provider = new MondayProvider(baseMondayConfig);
    const task = await provider.fetchTaskById('2001');

    assert.ok(task !== null);
    assert.deepEqual(task!.blockedBy, ['5555']);
  });

  it('returns null when the item is not found', async () => {
    mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof (init?.body) === 'string' ? JSON.parse(init.body) : {};
      if ((body.query as string)?.includes('items(ids')) {
        return jsonResponse({ data: { items: [] } });
      }
      return jsonResponse({});
    });

    const provider = new MondayProvider(baseMondayConfig);
    const task = await provider.fetchTaskById('nonexistent');

    assert.equal(task, null);
  });
});

// ─── NotionProvider.fetchTasks — blockedBy ────────────────────────────────────

describe('NotionProvider.fetchTasks — blockedBy', () => {
  afterEach(() => mock.restoreAll());

  function mockNotionFetch(pages: unknown[]) {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/databases/') && !url.includes('/query') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
          properties: { Name: { type: 'title' }, Status: { type: 'status' } },
        });
      }
      if (url.includes('/query')) {
        return jsonResponse({ results: pages, next_cursor: null, has_more: false });
      }
      return jsonResponse({});
    });
  }

  it('populates blockedBy from a "Blocked By" relation property', async () => {
    mockNotionFetch([{
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      url: 'https://notion.so/aaaaaaaaaabbbbccccddddeeeeeeeeeeee',
      properties: {
        Name: { title: [{ plain_text: 'Blocked page' }] },
        Status: { status: { name: 'pending' } },
        'Blocked By': { type: 'relation', relation: [{ id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff' }] },
      },
    }]);

    const provider = new NotionProvider(baseNotionConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].blockedBy, ['bbbbbbbb-cccc-dddd-eeee-ffffffffffff']);
  });

  it('omits blockedBy when no "Blocked By" property exists', async () => {
    mockNotionFetch([{
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      url: 'https://notion.so/aaaaaaaaaabbbbccccddddeeeeeeeeeeee',
      properties: {
        Name: { title: [{ plain_text: 'Unblocked page' }] },
        Status: { status: { name: 'pending' } },
      },
    }]);

    const provider = new NotionProvider(baseNotionConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].blockedBy, undefined);
  });
});

// ─── NotionProvider.fetchTaskById ────────────────────────────────────────────

describe('NotionProvider.fetchTaskById', () => {
  afterEach(() => mock.restoreAll());

  function mockNotionPageFetch(pageId: string, page: unknown) {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/databases/') && !url.includes('/query') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
          properties: { Name: { type: 'title' }, Status: { type: 'status' } },
        });
      }
      if (url.includes(`/pages/${pageId}`)) {
        return jsonResponse(page);
      }
      return jsonResponse({});
    });
  }

  it('returns a mapped Task with correct id and status', async () => {
    const uuidPageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockNotionPageFetch(uuidPageId, {
      id: uuidPageId,
      url: 'https://notion.so/aaaaaaaabbbbccccddddeeeeeeeeeeee',
      properties: {
        Name: { title: [{ plain_text: 'Fetched page' }] },
        Status: { status: { name: 'In Progress' } },
      },
    });

    const provider = new NotionProvider(baseNotionConfig);
    const task = await provider.fetchTaskById('aaaaaaaabbbbccccddddeeeeeeeeeeee');

    assert.ok(task !== null);
    assert.equal(task!.id, 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
    assert.equal(task!.name, 'Fetched page');
    assert.equal(task!.status, 'in progress');
    assert.equal(task!.blockedBy, undefined);
  });

  it('populates blockedBy from "Blocked By" relation when present', async () => {
    const uuidPageId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    mockNotionPageFetch(uuidPageId, {
      id: uuidPageId,
      url: 'https://notion.so/aaaaaaaabbbbccccddddeeeeeeeeeeee',
      properties: {
        Name: { title: [{ plain_text: 'Blocked page' }] },
        Status: { status: { name: 'pending' } },
        'Blocked By': { type: 'relation', relation: [{ id: 'cccccccc-dddd-eeee-ffff-000000000000' }] },
      },
    });

    const provider = new NotionProvider(baseNotionConfig);
    const task = await provider.fetchTaskById('aaaaaaaabbbbccccddddeeeeeeeeeeee');

    assert.ok(task !== null);
    assert.deepEqual(task!.blockedBy, ['cccccccc-dddd-eeee-ffff-000000000000']);
  });

  it('returns null when the page fetch fails', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/databases/') && !url.includes('/query') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
          properties: { Name: { type: 'title' }, Status: { type: 'status' } },
        });
      }
      return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'not found' };
    });

    const provider = new NotionProvider(baseNotionConfig);
    const task = await provider.fetchTaskById('aaaaaaaabbbbccccddddeeeeeeeeeeee');

    assert.equal(task, null);
  });
});

// ─── TrelloProvider.fetchTaskById ─────────────────────────────────────────────

describe('TrelloProvider.fetchTaskById', () => {
  afterEach(() => mock.restoreAll());

  it('returns a mapped Task with correct id, name, and status', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/cards/card42')) {
        return jsonResponse({
          id: 'card42',
          name: 'My card',
          desc: 'Some description',
          url: 'https://trello.com/c/xyz/card42',
          idList: 'list-todo',
          idMembers: ['member-me'],
          labels: [{ id: 'l1', name: 'aidev' }],
        });
      }
      if (url.includes('/boards/board1/lists')) {
        return jsonResponse([
          { id: 'list-todo', name: 'To Do' },
          { id: 'list-pending', name: 'Blocked' },
          { id: 'list-doing', name: 'Doing' },
          { id: 'list-review', name: 'In Review' },
        ]);
      }
      return jsonResponse({});
    });

    const provider = new TrelloProvider(baseTrelloConfig);
    const task = await provider.fetchTaskById('card42');

    assert.ok(task !== null);
    assert.equal(task!.id, 'card42');
    assert.equal(task!.name, 'My card');
    assert.equal(task!.status, 'open');
    assert.equal(task!.blockedBy, undefined);
  });

  it('derives status from list name when card is in a known list', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/cards/card99')) {
        return jsonResponse({
          id: 'card99',
          name: 'In progress card',
          desc: '',
          url: 'https://trello.com/c/abc/card99',
          idList: 'list-doing',
          idMembers: [],
          labels: [],
        });
      }
      if (url.includes('/boards/board1/lists')) {
        return jsonResponse([
          { id: 'list-todo', name: 'To Do' },
          { id: 'list-pending', name: 'Blocked' },
          { id: 'list-doing', name: 'Doing' },
          { id: 'list-review', name: 'In Review' },
        ]);
      }
      return jsonResponse({});
    });

    const provider = new TrelloProvider(baseTrelloConfig);
    const task = await provider.fetchTaskById('card99');

    assert.ok(task !== null);
    assert.equal(task!.id, 'card99');
    assert.equal(task!.status, 'in progress');
  });

  it('returns null when the card fetch fails', async () => {
    mock.method(globalThis, 'fetch', async () =>
      ({ ok: false, status: 404, statusText: 'Not Found', text: async () => 'not found' })
    );

    const provider = new TrelloProvider(baseTrelloConfig);
    const task = await provider.fetchTaskById('nonexistent');

    assert.equal(task, null);
  });
});

// ─── NotionProvider tag filtering ───────────────────────────────────────────

describe('NotionProvider.fetchTasks — tag filter', () => {
  afterEach(() => mock.restoreAll());

  it('filters pages by CLICKUP_TAG in Tags multi_select', async () => {
    mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/databases/') && !url.includes('/query') && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse({
          id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
          properties: {
            Name: { type: 'title' },
            Status: { type: 'status' },
            Tags: { type: 'multi_select' },
          },
        });
      }
      if (url.includes('/query')) {
        return jsonResponse({
          results: [
            {
              id: 'a1b2c3d4-e5f6-7890-1234-5678abcdef01',
              url: 'https://notion.so/page-one',
              properties: {
                Name: { title: [{ plain_text: 'Consult me' }] },
                Status: { status: { name: 'pending' } },
                Tags: { multi_select: [{ name: 'isaac-consult' }, { name: 'qelos' }] },
              },
            },
            {
              id: 'a1b2c3d4-e5f6-7890-1234-5678abcdef02',
              url: 'https://notion.so/page-two',
              properties: {
                Name: { title: [{ plain_text: 'Other task' }] },
                Status: { status: { name: 'pending' } },
                Tags: { multi_select: [{ name: 'qelos' }] },
              },
            },
          ],
          next_cursor: null,
          has_more: false,
        });
      }
      return jsonResponse({});
    });

    const provider = new NotionProvider({ ...baseNotionConfig, clickupTag: 'isaac-consult' } as unknown as Config);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, 'Consult me');
    assert.deepEqual(tasks[0].tags, ['isaac-consult', 'qelos']);
  });
});

// ─── MondayProvider tag filtering ─────────────────────────────────────────────

describe('MondayProvider.fetchTasks — tag filter', () => {
  afterEach(() => mock.restoreAll());

  it('filters items by CLICKUP_TAG in MONDAY_TAG_COLUMN_ID text column', async () => {
    mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const query = body.query as string;
      if (query.includes('boards') && query.includes('items_page')) {
        return jsonResponse({
          data: {
            boards: [
              {
                items_page: {
                  cursor: null,
                  items: [
                    {
                      id: '1001',
                      name: 'Consult task',
                      url: 'https://example.monday.com/boards/12345/pulses/1001',
                      description: { description: '' },
                      column_values: [
                        { id: 'status', value: '{"label":"Working on it"}', text: 'Working on it' },
                        { id: 'tags_col', value: null, text: 'qelos, isaac-consult' },
                      ],
                    },
                    {
                      id: '1002',
                      name: 'Other task',
                      url: 'https://example.monday.com/boards/12345/pulses/1002',
                      description: { description: '' },
                      column_values: [
                        { id: 'status', value: '{"label":"Working on it"}', text: 'Working on it' },
                        { id: 'tags_col', value: null, text: 'qelos' },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new MondayProvider({
      ...baseMondayConfig,
      clickupTag: 'isaac-consult',
      mondayTagColumnId: 'tags_col',
    } as unknown as Config);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].name, 'Consult task');
    assert.deepEqual(tasks[0].tags, ['qelos', 'isaac-consult']);
  });
});

describe('MondayProvider.addTag/removeTag', () => {
  afterEach(() => mock.restoreAll());

  it('updates the configured text tag column', async () => {
    const columnUpdates: Array<{ itemId: string; value: string }> = [];
    let columnText = 'isaac-consult';

    mock.method(globalThis, 'fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
      const query = body.query as string;
      if (query.includes('items(ids:')) {
        return jsonResponse({
          data: {
            items: [
              {
                id: '1001',
                column_values: [
                  { id: 'tags_col', value: null, text: columnText },
                ],
              },
            ],
          },
        });
      }
      if (query.includes('change_column_value')) {
        columnUpdates.push({ itemId: body.variables.itemId, value: body.variables.value });
        const parsed = JSON.parse(body.variables.value) as { text?: string };
        columnText = parsed.text ?? '';
        return jsonResponse({ data: { change_column_value: { id: '1001' } } });
      }
      return jsonResponse({ data: {} });
    });

    const provider = new MondayProvider({
      ...baseMondayConfig,
      mondayTagColumnId: 'tags_col',
    } as unknown as Config);

    await provider.removeTag!('1001', 'isaac-consult');
    await provider.addTag!('1001', 'isaac-consulted');

    assert.equal(columnUpdates.length, 2);
    assert.equal(columnUpdates[0].value, JSON.stringify({ text: '' }));
    assert.equal(columnUpdates[1].value, JSON.stringify({ text: 'isaac-consulted' }));
  });
});

describe('getTagsFromMondayColumnValues', () => {
  it('parses comma-separated text tags', () => {
    const tags = getTagsFromMondayColumnValues(
      [{ id: 'tags_col', value: null, text: 'qelos, isaac-consult' }],
      'tags_col',
    );
    assert.deepEqual(tags, ['qelos', 'isaac-consult']);
  });
});

// ─── AgendaProvider ─────────────────────────────────────────────────────────

const baseAgendaConfig = {
  agendaUrl: 'http://127.0.0.1:7420',
  agendaToken: 'ag_test',
  agendaWorkspaceId: '01a15e5d-1c71-71fd-a9b2-e7743a9b8739',
  agendaPendingStatus: 'Pending',
  agendaInReviewStatus: 'In Review',
  commentPrefix: '[aidev-sendfax]',
  assigneeTag: '',
} as unknown as Config;

const AGENDA_WS = '01a15e5d-1c71-71fd-a9b2-e7743a9b8739';
const AGENDA_TEAM = 'team-sen';

function agendaBootstrap() {
  return {
    teams: [{ id: AGENDA_TEAM, key: 'SEN', name: 'SendFax', workspace_id: AGENDA_WS, position: 0 }],
    states: [
      { id: 's-backlog', team_id: AGENDA_TEAM, name: 'Backlog', type: 'backlog' },
      { id: 's-todo', team_id: AGENDA_TEAM, name: 'Todo', type: 'unstarted' },
      { id: 's-progress', team_id: AGENDA_TEAM, name: 'In Progress', type: 'started' },
      { id: 's-review', team_id: AGENDA_TEAM, name: 'In Review', type: 'started' },
      { id: 's-done', team_id: AGENDA_TEAM, name: 'Done', type: 'completed' },
    ],
    labels: [
      { id: 'l-accepted', name: 'accepted' },
      { id: 'l-review', name: 'agent review' },
    ],
  };
}

function agendaIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: 'issue-72',
    identifier: 'SEN-72',
    team_id: AGENDA_TEAM,
    title: 'Admin Dashboard',
    description: 'Add a tab named Agenda to the admin dashboard.',
    state_id: 's-todo',
    priority: 2,
    label_ids: ['l-accepted'],
    parent_id: null,
    workspace_id: AGENDA_WS,
    updated_at: '2026-10-28T15:00:00.000Z',
    comments: [],
    relations: [],
    ...overrides,
  };
}

function agendaJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    issue_id: 'issue-72',
    identifier: 'SEN-72',
    issue_title: 'Admin Dashboard',
    workspace_id: AGENDA_WS,
    kind: 'task',
    requested_text: '@aidev now remove this test tab from the admin',
    status: 'queued',
    claimed_by: null,
    branch: null,
    created_at: '2026-10-28T15:53:09.298Z',
    updated_at: '2026-10-28T15:53:09.298Z',
    project_path: '/Users/adigoldstein/Documents/MY CODING PROJECTS/SendFax.me',
    ...overrides,
  };
}

interface AgendaCall {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Fake AGenda server: records every call, answers from a small route table. */
function mockAgenda(opts: {
  jobs?: Array<Record<string, unknown>>;
  issue?: Record<string, unknown>;
  reviewIssues?: Array<Record<string, unknown>>;
  onReport?: (body: Record<string, unknown>) => Record<string, unknown>;
}) {
  const calls: AgendaCall[] = [];
  let jobs = opts.jobs ?? [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    const headers = (init?.headers || {}) as Record<string, string>;
    calls.push({ method, path: u.pathname + u.search, body, headers });

    if (u.pathname === '/api/bootstrap') return jsonResponse(agendaBootstrap());
    if (u.pathname === '/api/aidev/jobs') {
      const statuses = (u.searchParams.get('status') || '').split(',').filter(Boolean);
      const issue = u.searchParams.get('issue');
      const items = jobs.filter(
        (j) =>
          (statuses.length === 0 || statuses.includes(j.status as string)) &&
          (!issue || j.identifier === issue || j.issue_id === issue),
      );
      return jsonResponse({ items });
    }
    const claim = u.pathname.match(/^\/api\/aidev\/jobs\/([^/]+)\/claim$/);
    if (claim && method === 'POST') {
      const job = jobs.find((j) => j.id === claim[1]);
      if (!job) return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":{"message":"job not found"}}' };
      if (job.status !== 'queued') return { ok: false, status: 409, statusText: 'Conflict', text: async () => '{"error":{"message":"job is claimed"}}' };
      job.status = 'claimed';
      job.claimed_by = body?.by;
      return jsonResponse(job);
    }
    const report = u.pathname.match(/^\/api\/aidev\/jobs\/([^/]+)\/report$/);
    if (report && method === 'POST') {
      const job = jobs.find((j) => j.id === report[1]);
      if (!job) return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":{"message":"job not found"}}' };
      job.status = body?.status;
      return jsonResponse(opts.onReport ? opts.onReport(body!) : job);
    }
    if (u.pathname === '/api/issues' && method === 'GET') return jsonResponse({ items: opts.reviewIssues ?? [] });
    if (u.pathname === '/api/issues' && method === 'POST') {
      return jsonResponse({ ...agendaIssue(), id: 'issue-new', identifier: 'SEN-99', title: body?.title });
    }
    const comments = u.pathname.match(/^\/api\/issues\/([^/]+)\/comments$/);
    if (comments && method === 'POST') return jsonResponse({ id: 'c-new', body: body?.body });
    const issue = u.pathname.match(/^\/api\/issues\/([^/]+)$/);
    if (issue) {
      if (!opts.issue || (opts.issue.identifier !== decodeURIComponent(issue[1]) && opts.issue.id !== decodeURIComponent(issue[1]))) {
        return { ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":{"code":"not_found","message":"issue not found"}}' };
      }
      if (method === 'PATCH') return jsonResponse({ ...opts.issue, ...body });
      return jsonResponse(opts.issue);
    }
    return { ok: false, status: 500, statusText: 'unexpected', text: async () => `no route for ${method} ${u.pathname}` };
  });
  return { calls, setJobs: (next: Array<Record<string, unknown>>) => { jobs = next; } };
}

describe('mapAgendaJobStatus', () => {
  it('maps queued jobs to open and queued replies to the pending status', () => {
    assert.equal(mapAgendaJobStatus({ status: 'queued', kind: 'task' }, 'Pending'), 'open');
    assert.equal(mapAgendaJobStatus({ status: 'queued', kind: 'push' }, 'Pending'), 'open');
    assert.equal(mapAgendaJobStatus({ status: 'queued', kind: 'reply' }, 'Pending'), 'Pending');
  });

  it('maps claimed and running to in progress, needs_input to a skipped status, terminal statuses to done/failed/cancelled', () => {
    assert.equal(mapAgendaJobStatus({ status: 'claimed', kind: 'task' }, 'Pending'), 'in progress');
    assert.equal(mapAgendaJobStatus({ status: 'running', kind: 'task' }, 'Pending'), 'in progress');
    assert.equal(mapAgendaJobStatus({ status: 'needs_input', kind: 'task' }, 'Pending'), 'needs input');
    assert.equal(mapAgendaJobStatus({ status: 'done', kind: 'task' }, 'Pending'), 'done');
    assert.equal(mapAgendaJobStatus({ status: 'failed', kind: 'task' }, 'Pending'), 'failed');
    assert.equal(mapAgendaJobStatus({ status: 'canceled', kind: 'task' }, 'Pending'), 'cancelled');
  });
});

describe('getBlockedByFromAgendaRelations', () => {
  it('collects incoming "blocks" relations as blockers', () => {
    const blockedBy = getBlockedByFromAgendaRelations([
      { type: 'blocks', direction: 'incoming', issue: { identifier: 'SEN-5' } },
      { type: 'blocks', direction: 'outgoing', issue: { identifier: 'SEN-99' } },
      { type: 'related', direction: 'incoming', issue: { identifier: 'SEN-7' } },
    ]);
    assert.deepEqual(blockedBy, ['SEN-5']);
  });

  it('returns an empty list without relations', () => {
    assert.deepEqual(getBlockedByFromAgendaRelations(undefined), []);
  });
});

describe('AgendaProvider.fetchTasks', () => {
  afterEach(() => mock.restoreAll());

  it('lists open @aidev jobs of the workspace as tasks with the issue identifier as id', async () => {
    const { calls } = mockAgenda({ jobs: [agendaJob()], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    const tasks = await provider.fetchTasks();

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'SEN-72');
    assert.equal(tasks[0].name, 'Admin Dashboard');
    assert.equal(tasks[0].status, 'open');
    assert.equal(tasks[0].url, 'http://127.0.0.1:7420/issue/SEN-72');
    assert.deepEqual(tasks[0].tags, ['accepted']);
    assert.equal(tasks[0].priority, 2);
    assert.equal(tasks[0].sourceListId, AGENDA_WS);
    assert.ok(tasks[0].description.startsWith('Add a tab named Agenda'));
    assert.ok(tasks[0].description.includes('@aidev now remove this test tab'), 'comment request is appended');

    const jobsCall = calls.find((c) => c.path.startsWith('/api/aidev/jobs?'));
    assert.ok(jobsCall);
    assert.ok(jobsCall.path.includes('status=queued%2Cclaimed%2Crunning%2Cneeds_input'));
    assert.ok(jobsCall.path.includes(`workspace_id=${AGENDA_WS}`));
    assert.equal(jobsCall.headers.Authorization, 'Bearer ag_test');
    assert.equal(jobsCall.headers['X-Agenda-Client'], 'aidev-dispatcher');
  });

  it('reports a queued reply job as pending so the conversation is re-read', async () => {
    mockAgenda({ jobs: [agendaJob({ kind: 'reply', requested_text: 'Yes, remove it' })], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    const tasks = await provider.fetchTasks();
    assert.equal(tasks[0].status, 'Pending');
  });

  it('does not repeat the request when it is already the issue description', async () => {
    mockAgenda({
      jobs: [agendaJob({ requested_text: '@aidev build it' })],
      issue: agendaIssue({ description: '@aidev build it' }),
    });
    const provider = new AgendaProvider(baseAgendaConfig);
    const tasks = await provider.fetchTasks();
    assert.equal(tasks[0].description, '@aidev build it');
  });

  it('resolves a workspace given by name', async () => {
    const { calls } = mockAgenda({ jobs: [], issue: agendaIssue() });
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const u = new URL(String(url));
      calls.push({ method: 'GET', path: u.pathname + u.search, headers: {} });
      if (u.pathname === '/api/bootstrap' && !u.searchParams.get('workspace_id')) {
        return jsonResponse({ ...agendaBootstrap(), workspaces: [{ id: AGENDA_WS, name: 'SendFax' }] });
      }
      return jsonResponse({ items: [] });
    });
    const provider = new AgendaProvider({ ...baseAgendaConfig, agendaWorkspaceId: 'sendfax' } as unknown as Config);
    await provider.fetchTasks();
    assert.ok(calls.some((c) => c.path === '/api/bootstrap'));
    assert.ok(calls.some((c) => c.path.includes(`workspace_id=${AGENDA_WS}`)));
  });

  it('fails clearly when the workspace is not configured', async () => {
    mockAgenda({ jobs: [] });
    const provider = new AgendaProvider({ ...baseAgendaConfig, agendaWorkspaceId: '' } as unknown as Config);
    await assert.rejects(() => provider.fetchTasks(), /AGENDA_WORKSPACE_ID is not set/);
  });
});

describe('AgendaProvider.fetchTaskById', () => {
  afterEach(() => mock.restoreAll());

  it('uses the issue workflow state when the issue has no open job (blockers)', async () => {
    mockAgenda({ jobs: [agendaJob({ status: 'done' })], issue: agendaIssue({ state_id: 's-done' }) });
    const provider = new AgendaProvider(baseAgendaConfig);
    const task = await provider.fetchTaskById('SEN-72');
    assert.ok(task);
    assert.equal(task.status, 'Done');
  });

  it('returns null when the issue does not exist', async () => {
    mockAgenda({ jobs: [], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    assert.equal(await provider.fetchTaskById('SEN-999'), null);
  });

  it('populates blockedBy from incoming blocks relations', async () => {
    mockAgenda({
      jobs: [agendaJob()],
      issue: agendaIssue({ relations: [{ type: 'blocks', direction: 'incoming', issue: { identifier: 'SEN-3' } }] }),
    });
    const provider = new AgendaProvider(baseAgendaConfig);
    const task = await provider.fetchTaskById('SEN-72');
    assert.ok(task);
    assert.deepEqual(task.blockedBy, ['SEN-3']);
  });
});

describe('AgendaProvider.fetchTasksByStatus', () => {
  afterEach(() => mock.restoreAll());

  it('adds issues sitting in the in-review workflow state when asked for the review status', async () => {
    const { calls } = mockAgenda({
      jobs: [agendaJob()],
      issue: agendaIssue(),
      reviewIssues: [agendaIssue({ id: 'issue-70', identifier: 'SEN-70', title: 'Old task', state_id: 's-review', label_ids: ['l-review'] })],
    });
    const provider = new AgendaProvider(baseAgendaConfig);
    const tasks = await provider.fetchTasksByStatus(['In Review']);
    assert.deepEqual(tasks.map((t) => t.id), ['SEN-70']);
    assert.equal(tasks[0].status, 'In Review');
    assert.deepEqual(tasks[0].tags, ['agent review']);
    const listCall = calls.find((c) => c.path.startsWith('/api/issues?'));
    assert.ok(listCall);
    assert.ok(listCall.path.includes('state_id=s-review'));
  });

  it('filters open jobs by status without touching the issue list', async () => {
    const { calls } = mockAgenda({ jobs: [agendaJob(), agendaJob({ id: 'job-2', identifier: 'SEN-73', issue_id: 'issue-73', status: 'running' })], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    const tasks = await provider.fetchTasksByStatus(['open']);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'open');
    assert.ok(!calls.some((c) => c.path.startsWith('/api/issues?')));
  });
});

describe('AgendaProvider.getComments', () => {
  afterEach(() => mock.restoreAll());

  it('returns issue comments sorted by date and marks AIdev server comments with the prefix', async () => {
    mockAgenda({
      jobs: [],
      issue: agendaIssue({
        comments: [
          { id: 'c2', body: '@aidev merge', created_at: '2026-10-28T16:07:30.641Z', author: 'me', actor: null },
          { id: 'c1', body: '[aidev-sendfax] Starting implementation on branch `SEN-72/admin`', created_at: '2026-10-28T15:55:00.000Z', author: 'aidev-pi', actor: 'aidev-pi' },
          { id: 'c0', body: '**Question from AIdev:** Which tab?', created_at: '2026-10-28T15:54:00.000Z', author: 'AIdev', actor: 'AIdev' },
        ],
      }),
    });
    const provider = new AgendaProvider(baseAgendaConfig);
    const comments = await provider.getComments('SEN-72');
    assert.deepEqual(comments.map((c) => c.id), ['c0', 'c1', 'c2']);
    assert.ok(comments[0].text.startsWith('[aidev-sendfax] '), 'AIdev actor comment gets the prefix');
    assert.equal(comments[1].text, '[aidev-sendfax] Starting implementation on branch `SEN-72/admin`');
    assert.equal(comments[2].text, '@aidev merge');
    assert.equal(comments[2].author, 'me');
    assert.equal(comments[2].date, new Date('2026-10-28T16:07:30.641Z').getTime());
  });
});

describe('AgendaProvider.postComment', () => {
  afterEach(() => mock.restoreAll());

  it('posts a plain comment on the issue', async () => {
    const { calls } = mockAgenda({ jobs: [agendaJob()], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.postComment('SEN-72', '[aidev-sendfax] Starting implementation');
    const call = calls.find((c) => c.method === 'POST' && c.path === '/api/issues/SEN-72/comments');
    assert.ok(call);
    assert.deepEqual(call.body, { body: '[aidev-sendfax] Starting implementation' });
  });
});

describe('AgendaProvider.updateStatus — job queue', () => {
  afterEach(() => mock.restoreAll());

  it('"in progress" claims a queued job and reports it running', async () => {
    const { calls } = mockAgenda({ jobs: [agendaJob()], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.updateStatus('SEN-72', 'in progress');
    const claim = calls.find((c) => c.path === '/api/aidev/jobs/job-1/claim');
    assert.ok(claim, 'claims the job');
    assert.ok(typeof claim.body?.by === 'string' && (claim.body.by as string).startsWith('aidev@'));
    const report = calls.find((c) => c.path === '/api/aidev/jobs/job-1/report');
    assert.ok(report);
    assert.deepEqual(report.body, { status: 'running' });
    assert.ok(!calls.some((c) => c.method === 'PATCH'), 'does not touch the issue state directly');
  });

  it('does not re-report a job that is already running', async () => {
    const { calls } = mockAgenda({ jobs: [agendaJob({ status: 'running' })], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.updateStatus('SEN-72', 'in progress');
    assert.ok(!calls.some((c) => c.path.endsWith('/claim') || c.path.endsWith('/report')));
  });

  it('pending status reports needs_input', async () => {
    const { calls } = mockAgenda({ jobs: [agendaJob({ status: 'claimed' })], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.updateStatus('SEN-72', 'Pending');
    const report = calls.find((c) => c.path === '/api/aidev/jobs/job-1/report');
    assert.ok(report);
    assert.deepEqual(report.body, { status: 'needs_input' });
  });

  it('in-review status reports done (case-insensitive)', async () => {
    const { calls } = mockAgenda({ jobs: [agendaJob({ status: 'running' })], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.updateStatus('SEN-72', 'in review');
    const report = calls.find((c) => c.path === '/api/aidev/jobs/job-1/report');
    assert.ok(report);
    assert.deepEqual(report.body, { status: 'done' });
  });

  it('does not re-claim a job another dispatcher already holds', async () => {
    const { calls } = mockAgenda({ jobs: [agendaJob({ status: 'claimed', claimed_by: 'someone else' })], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.updateStatus('SEN-72', 'in progress');
    assert.ok(!calls.some((c) => c.path.endsWith('/claim')), 'no claim call');
    const report = calls.find((c) => c.path === '/api/aidev/jobs/job-1/report');
    assert.ok(report);
    assert.deepEqual(report.body, { status: 'running' });
  });

  it('surfaces the 409 from a claim that lost the race', async () => {
    mockAgenda({ jobs: [agendaJob()], issue: agendaIssue() });
    mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/claim')) {
        return { ok: false, status: 409, statusText: 'Conflict', text: async () => JSON.stringify({ error: { code: 'conflict', message: 'job is claimed (claimed by other)' } }) };
      }
      if (u.pathname === '/api/aidev/jobs') return jsonResponse({ items: [agendaJob()] });
      return jsonResponse({});
    });
    const provider = new AgendaProvider(baseAgendaConfig);
    await assert.rejects(() => provider.updateStatus('SEN-72', 'in progress'), /AGenda API error 409: job is claimed/);
  });
});

describe('AgendaProvider.updateStatus — workflow state fallback', () => {
  afterEach(() => mock.restoreAll());

  it('sets the issue state by name when there is no open job', async () => {
    const { calls } = mockAgenda({ jobs: [agendaJob({ status: 'done' })], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.updateStatus('SEN-72', 'Backlog');
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch);
    assert.equal(patch.path, '/api/issues/issue-72');
    assert.deepEqual(patch.body, { state_id: 's-backlog' });
  });

  it('falls back to the state type when no state name matches ("done" → completed)', async () => {
    const { calls } = mockAgenda({ jobs: [], issue: agendaIssue({ state_id: 's-review' }) });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.updateStatus('SEN-72', 'done');
    const patch = calls.find((c) => c.method === 'PATCH');
    assert.ok(patch);
    assert.deepEqual(patch.body, { state_id: 's-done' });
  });

  it('skips the PATCH when the issue is already in that state', async () => {
    const { calls } = mockAgenda({ jobs: [], issue: agendaIssue({ state_id: 's-done' }) });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.updateStatus('SEN-72', 'Done');
    assert.ok(!calls.some((c) => c.method === 'PATCH'));
  });

  it('throws a helpful error when nothing matches', async () => {
    mockAgenda({ jobs: [], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    await assert.rejects(() => provider.updateStatus('SEN-72', 'Nowhere'), /no workflow state matching "Nowhere"/);
  });
});

describe('AgendaProvider.fetchAvailableStatuses', () => {
  afterEach(() => mock.restoreAll());

  it('returns the workflow state names', async () => {
    mockAgenda({ jobs: [] });
    const provider = new AgendaProvider(baseAgendaConfig);
    const statuses = await provider.fetchAvailableStatuses();
    assert.deepEqual(statuses, ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done']);
  });
});

describe('AgendaProvider.addTag / removeTag', () => {
  afterEach(() => mock.restoreAll());

  it('patches labels by name', async () => {
    const { calls } = mockAgenda({ jobs: [], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    await provider.addTag('SEN-72', 'agent review');
    await provider.removeTag('SEN-72', 'accepted');
    const patches = calls.filter((c) => c.method === 'PATCH');
    assert.deepEqual(patches.map((c) => c.body), [{ add_labels: ['agent review'] }, { remove_labels: ['accepted'] }]);
  });

  it('surfaces the server error for keys that may not change labels', async () => {
    mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => JSON.stringify({ error: { code: 'forbidden', message: "dispatcher keys can only change an issue's state" } }),
    }));
    const provider = new AgendaProvider(baseAgendaConfig);
    await assert.rejects(() => provider.addTag('SEN-72', 'agent review'), /AGenda API error 403: dispatcher keys can only change/);
  });
});

describe('AgendaProvider.createTask', () => {
  afterEach(() => mock.restoreAll());

  it('creates an issue in the workspace team and returns identifier and url', async () => {
    const { calls } = mockAgenda({ jobs: [], issue: agendaIssue() });
    const provider = new AgendaProvider(baseAgendaConfig);
    const result = await provider.createTask({ title: 'Sub task', description: 'Do it', tags: ['planning'], priority: 3 });
    assert.equal(result.id, 'SEN-99');
    assert.equal(result.url, 'http://127.0.0.1:7420/issue/SEN-99');
    const create = calls.find((c) => c.method === 'POST' && c.path === '/api/issues');
    assert.ok(create);
    assert.deepEqual(create.body, { team_id: AGENDA_TEAM, title: 'Sub task', description: 'Do it', priority: 3, labels: ['planning'] });
  });
});

describe('AgendaProvider — project tag through a whole run (Pi regression)', () => {
  afterEach(() => mock.restoreAll());

  // What the Pi ran: PROVIDER=agenda in the blockhub.dev clone, default
  // AGENDA_LABEL=*, CLICKUP_TAG defaulting to the folder name.
  const piConfig = {
    ...baseAgendaConfig,
    provider: 'agenda',
    clickupTag: 'blockhub.dev',
    agendaLabel: '*',
    nonCodeTag: 'blockhub.dev-other',
    consultTag: 'blockhub.dev-consult',
  } as unknown as Config;

  function bhIssue(labels: string[] = []) {
    return agendaIssue({
      id: 'issue-44',
      identifier: 'BH-44',
      title: 'Improve the GitHub readme.',
      description: 'Make the readme useful.',
      label_ids: labels,
    });
  }

  function bhJob(overrides: Record<string, unknown> = {}) {
    return agendaJob({
      id: 'job-44',
      issue_id: 'issue-44',
      identifier: 'BH-44',
      issue_title: 'Improve the GitHub readme.',
      requested_text: '@aidev and add all the links',
      ...overrides,
    });
  }

  it('list queued -> claim -> re-poll during the run keeps status "in progress" and the project tag', async () => {
    const job = bhJob();
    mockAgenda({ jobs: [job], issue: bhIssue() });
    const provider = new AgendaProvider(piConfig);

    const listed = await provider.fetchTasks();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].status, 'open');
    assert.deepEqual(listed[0].tags, ['blockhub.dev'], 'picked-up task carries the project tag');

    await provider.updateStatus('BH-44', 'in progress');
    assert.equal(job.status, 'running');

    // The status watcher re-reads the task every few seconds while the agent runs.
    for (let poll = 0; poll < 3; poll++) {
      const again = await provider.fetchTaskById('BH-44');
      assert.ok(again);
      assert.equal(again.status, 'in progress');
      assert.deepEqual(again.tags, ['blockhub.dev']);
      const check = await checkImplementationStillActive(provider, 'BH-44', piConfig, 'code');
      assert.deepEqual(check, { active: true });
    }
  });

  it('a job that was already claimed by this dispatcher is still found and active (not only queued)', async () => {
    mockAgenda({ jobs: [bhJob({ status: 'claimed', claimed_by: 'aidev@pi' })], issue: bhIssue() });
    const provider = new AgendaProvider(piConfig);
    const task = await provider.fetchTaskById('BH-44');
    assert.ok(task);
    assert.equal(task.status, 'in progress');
    assert.deepEqual(task.tags, ['blockhub.dev']);
    assert.deepEqual(await checkImplementationStillActive(provider, 'BH-44', piConfig), { active: true });
  });

  it('a job canceled in AGenda during the run makes the status check stop the run', async () => {
    const job = bhJob();
    mockAgenda({ jobs: [job], issue: bhIssue() });
    const provider = new AgendaProvider(piConfig);
    await provider.fetchTasks();
    await provider.updateStatus('BH-44', 'in progress');
    job.status = 'canceled';
    const task = await provider.fetchTaskById('BH-44');
    assert.ok(task);
    assert.equal(task.status, 'cancelled');
    const check = await checkImplementationStillActive(provider, 'BH-44', piConfig);
    assert.equal(check.active, false);
  });

  it('a job that ended before this process started does not shadow the issue state', async () => {
    mockAgenda({ jobs: [bhJob({ status: 'canceled' })], issue: bhIssue() });
    const provider = new AgendaProvider(piConfig);
    const task = await provider.fetchTaskById('BH-44');
    assert.ok(task);
    assert.equal(task.status, 'Todo');
  });

  it('is not listed as non-code or consult unless the issue carries that label', async () => {
    mockAgenda({ jobs: [bhJob()], issue: bhIssue() });
    const nonCode = new AgendaProvider(buildNonCodeProviderConfig(piConfig));
    const consult = new AgendaProvider(buildConsultProviderConfig(piConfig));
    assert.deepEqual(await nonCode.fetchTasks(), []);
    assert.deepEqual(await consult.fetchTasks(), []);
  });

  it('lists a job as non-code when its issue carries the non-code label', async () => {
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/bootstrap') {
        const b = agendaBootstrap();
        b.labels.push({ id: 'l-other', name: 'blockhub.dev-other' });
        return jsonResponse(b);
      }
      if (u.pathname === '/api/aidev/jobs') return jsonResponse({ items: [bhJob()] });
      if (u.pathname === '/api/issues/BH-44') return jsonResponse(bhIssue(['l-other']));
      return jsonResponse({ items: [] });
    });
    const nonCode = new AgendaProvider(buildNonCodeProviderConfig(piConfig));
    const tasks = await nonCode.fetchTasks();
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].tags, ['blockhub.dev-other']);
    const code = new AgendaProvider(piConfig);
    const codeTasks = await code.fetchTasks();
    assert.deepEqual(codeTasks[0].tags, ['blockhub.dev-other', 'blockhub.dev'], 'wildcard main view adds the project tag');
  });

  it('AGENDA_LABEL filters jobs by issue label, like LINEAR_LABEL', async () => {
    mockAgenda({ jobs: [bhJob()], issue: bhIssue(['l-accepted']) });
    const filtered = new AgendaProvider({ ...piConfig, agendaLabel: 'readme' } as unknown as Config);
    assert.deepEqual(await filtered.fetchTasks(), []);
    const matching = new AgendaProvider({ ...piConfig, agendaLabel: 'accepted' } as unknown as Config);
    const tasks = await matching.fetchTasks();
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].tags, ['accepted']);
  });
});
