import { TOOLS, TOOL_MAP as EDIT_MAP } from './tools.ts';
import { PLANNER_SHARED, PLANNER_TOOLS } from './planner.ts';
import { ToolError } from './helpers.ts';
import type { Args, ToolCtx, ToolResult } from './helpers.ts';
import type { ToolDef } from './tools.ts';

export { TOOLS } from './tools.ts';

/** Every tool by name, the editor's and the planner's. */
export const TOOL_MAP = new Map<string, ToolDef>([...EDIT_MAP, ...PLANNER_TOOLS.map((t) => [t.name, t] as [string, ToolDef])]);

/** The tools a run on this project may use: the planner's on the footage library, the editor's elsewhere. */
export function toolsFor(projectId: string): ToolDef[] {
  if (projectId === 'library') return [...PLANNER_TOOLS, ...PLANNER_SHARED.map((n) => EDIT_MAP.get(n)!)];
  return TOOLS;
}
export type { ToolDef } from './tools.ts';
export { ToolError } from './helpers.ts';
export type { ToolCtx, ToolResult } from './helpers.ts';

/** Run one editing tool. Problems with the call come back as ToolError with a message fit to show. */
export async function callTool(ctx: ToolCtx, name: string, args: Args | undefined): Promise<ToolResult> {
  const tool = toolsFor(ctx.p.id).find((t) => t.name === name);
  if (!tool) throw new ToolError(`There is no tool called "${name}".`);
  return tool.run(ctx, args ?? {});
}

/** How the assistant's command-line client names a tool of this editor. */
export const MCP_PREFIX = 'mcp__studio__';

const NAMES = new RegExp(`\\b(${[...TOOL_MAP.keys()].sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');

/**
 * Write tool names the way the assistant has to call them. Instructions that
 * say "get_transcript" lead it to call exactly that, which does not exist.
 */
export function qualify(text: string): string {
  return text.replace(NAMES, `${MCP_PREFIX}$1`);
}
