import type { BuiltinTool, Todo, TodoStatus } from './types.js';
import { ToolError } from './util.js';

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * The run's task checklist. The list lives in memory; AgentMux draws its
 * progress checklist from the TodoWrite call's input, so the result only
 * needs to confirm.
 */
export const todoWriteTool: BuiltinTool = {
  spec: {
    name: 'TodoWrite',
    description:
      'Creates and updates the task list for this session. Use it for work with several steps: send the whole ' +
      'list each time, with each item\'s status (pending, in_progress or completed). Keep exactly one item ' +
      'in_progress while working, and mark items completed as soon as they are done.',
    inputSchema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The updated todo list',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', minLength: 1, description: 'The task, in imperative form (e.g. "Run the tests")' },
              status: { type: 'string', enum: STATUSES },
              activeForm: { type: 'string', description: 'The task in present continuous form (e.g. "Running the tests")' },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    _serverId: '',
    readOnly: true,
    builtin: true,
  },

  async run(input, ctx) {
    const raw = input.todos;
    if (!Array.isArray(raw)) throw new ToolError('"todos" is required and must be an array');
    const todos: Todo[] = raw.map((t, i) => {
      const item = (t ?? {}) as Record<string, unknown>;
      if (typeof item.content !== 'string' || !item.content.trim()) throw new ToolError(`todos[${i}].content must be a non-empty string`);
      if (!STATUSES.includes(item.status as TodoStatus)) throw new ToolError(`todos[${i}].status must be one of ${STATUSES.join(', ')}`);
      return {
        content: item.content,
        status: item.status as TodoStatus,
        ...(typeof item.activeForm === 'string' ? { activeForm: item.activeForm } : {}),
      };
    });
    ctx.todos = todos;
    const done = todos.filter(t => t.status === 'completed').length;
    return `Todo list updated (${done}/${todos.length} completed). Keep it current as you work, and continue with the next task.`;
  },
};
