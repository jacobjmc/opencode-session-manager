import { describe, expect, test } from 'bun:test';
import { SessionManager } from '../src/session-manager';

const formatLocal = (timestampMs) => {
  const date = new Date(timestampMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

const makeClient = ({
  defaultSessions = [],
  scopedSessions = {},
  messagesBySession = {},
  projects = [],
  failProjectList = false,
} = {}) => {
  const listCalls = [];
  const projectListCalls = [];

  const projectRecords = projects.map((worktree, index) => ({
    id: `proj-${index + 1}`,
    worktree,
    time: { created: 0 },
  }));

  const client = {
    project: {
      list: async (args) => {
        projectListCalls.push(args);
        if (failProjectList) {
          throw new Error('project list failed');
        }
        return { data: projectRecords };
      },
    },
    session: {
      list: async (args) => {
        listCalls.push(args);
        const directory = args?.query?.directory;
        const sessions = directory ? (scopedSessions[directory] ?? []) : defaultSessions;
        return { data: sessions };
      },
      messages: async (args) => ({ data: messagesBySession[args?.path?.id] ?? [] }),
      todo: async (_args) => ({ data: [] }),
      get: async (_args) => ({ data: null }),
    },
  };

  return { client, listCalls, projectListCalls };
};

describe('SessionManager', () => {
  test('uses context directory by default', async () => {
    const { client, listCalls } = makeClient();
    const plugin = await SessionManager({ client, directory: '/repo' });

    await plugin.tool.session_list.execute({}, { directory: '/repo' });

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.query).toEqual({ directory: '/repo' });
  });

  test('all_scopes queries sessions for every known project', async () => {
    const sessionsA = [
      {
        id: 'from-a',
        directory: '/project-a',
        title: 'A',
        time: { created: 0, updated: 200 },
      },
    ];
    const sessionsB = [
      {
        id: 'from-b',
        directory: '/project-b',
        title: 'B',
        time: { created: 0, updated: 100 },
      },
    ];

    const { client, listCalls, projectListCalls } = makeClient({
      projects: ['/project-a', '/project-b'],
      scopedSessions: {
        '/project-a': sessionsA,
        '/project-b': sessionsB,
      },
    });
    const plugin = await SessionManager({ client, directory: '/repo' });

    const output = await plugin.tool.session_list.execute(
      {
        all_scopes: true,
        project_path: '/should-not-be-used',
      },
      { directory: '/repo' }
    );

    expect(projectListCalls).toHaveLength(1);
    expect(projectListCalls[0]?.query).toEqual({});
    expect(listCalls).toHaveLength(2);
    expect(listCalls.map((call) => call?.query?.directory)).toEqual([
      '/project-a',
      '/project-b',
    ]);
    expect(output).toContain('from-a');
    expect(output).toContain('from-b');
    expect(output).not.toContain('/should-not-be-used');
  });

  test('all_scopes falls back to unscoped list if project listing fails', async () => {
    const { client, listCalls } = makeClient({
      failProjectList: true,
      defaultSessions: [
        {
          id: 'fallback-session',
          directory: '/fallback',
          title: 'Fallback',
          time: { created: 0, updated: 100 },
        },
      ],
    });
    const plugin = await SessionManager({ client, directory: '/repo' });

    const output = await plugin.tool.session_list.execute({ all_scopes: true }, { directory: '/repo' });

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]?.query).toEqual({});
    expect(output).toContain('fallback-session');
  });

  test('session_search defaults to current workspace scope', async () => {
    const currentSession = {
      id: 'current-scope',
      directory: '/project-a',
      title: 'Current',
      time: { created: 0, updated: 200 },
    };
    const otherSession = {
      id: 'other-scope',
      directory: '/project-b',
      title: 'Other',
      time: { created: 0, updated: 100 },
    };

    const message = (text, id = 'msg-1') => ({
      info: { id, role: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text }],
    });

    const { client } = makeClient({
      scopedSessions: {
        '/repo': [currentSession],
        '/project-b': [otherSession],
      },
      messagesBySession: {
        'current-scope': [message('contains only alpha term')],
        'other-scope': [message('contains only beta term', 'msg-2')],
      },
    });

    const plugin = await SessionManager({ client, directory: '/repo' });
    const output = await plugin.tool.session_search.execute(
      { query: 'beta', limit: 10 },
      { directory: '/repo' }
    );

    expect(output).toContain('No matches found.');
  });

  test('session_search supports all_scopes across workspaces', async () => {
    const currentSession = {
      id: 'current-scope',
      directory: '/project-a',
      title: 'Current',
      time: { created: 0, updated: 200 },
    };
    const otherSession = {
      id: 'other-scope',
      directory: '/project-b',
      title: 'Other',
      time: { created: 0, updated: 100 },
    };

    const message = (text, id = 'msg-1') => ({
      info: { id, role: 'user', time: { created: 1 } },
      parts: [{ type: 'text', text }],
    });

    const { client, projectListCalls, listCalls } = makeClient({
      projects: ['/project-a', '/project-b'],
      scopedSessions: {
        '/repo': [currentSession],
        '/project-a': [currentSession],
        '/project-b': [otherSession],
      },
      messagesBySession: {
        'current-scope': [message('contains only alpha term')],
        'other-scope': [message('contains beta term', 'msg-2')],
      },
    });

    const plugin = await SessionManager({ client, directory: '/repo' });
    const output = await plugin.tool.session_search.execute(
      { query: 'beta', all_scopes: true, limit: 10 },
      { directory: '/repo' }
    );

    expect(projectListCalls).toHaveLength(1);
    expect(listCalls.map((call) => call?.query?.directory)).toContain('/project-b');
    expect(output).toContain('other-scope');
  });

  test('date-only from_date and to_date include the full day', async () => {
    const sessions = [
      {
        id: 'in-range',
        directory: '/project-a',
        title: 'Included',
        time: {
          created: new Date('2026-03-03T23:59:59.900').getTime(),
          updated: new Date('2026-03-03T23:59:59.900').getTime(),
        },
      },
      {
        id: 'out-range',
        directory: '/project-a',
        title: 'Excluded',
        time: {
          created: new Date('2026-03-04T00:00:00.000').getTime(),
          updated: new Date('2026-03-04T00:00:00.000').getTime(),
        },
      },
    ];

    const { client } = makeClient({
      projects: ['/project-a'],
      scopedSessions: { '/project-a': sessions },
    });
    const plugin = await SessionManager({ client, directory: '/repo' });

    const output = await plugin.tool.session_list.execute(
      {
        all_scopes: true,
        from_date: '2026-03-03',
        to_date: '2026-03-03',
      },
      { directory: '/repo' }
    );

    expect(output).toContain('in-range');
    expect(output).not.toContain('out-range');
  });

  test('session_read formats timestamps in local runtime time', async () => {
    const createdAt = Date.UTC(2026, 2, 3, 23, 30, 45);
    const { client } = makeClient({
      messagesBySession: {
        'local-time-session': [
          {
            info: { id: 'msg-1', role: 'user', time: { created: createdAt } },
            parts: [{ type: 'text', text: 'hello' }],
          },
        ],
      },
    });

    const plugin = await SessionManager({ client, directory: '/repo' });
    const output = await plugin.tool.session_read.execute(
      { session_id: 'local-time-session' },
      { directory: '/repo' }
    );

    expect(output).toContain(`@ ${formatLocal(createdAt)}`);
  });
});
