import { KeelConfig } from '../config.js';
import { SessionStore } from '../core/store.js';

export interface ToolCtx {
  cwd: string;
  cfg: KeelConfig;
  store: SessionStore;
  interactive: boolean;
}

export interface ToolOutput {
  ok: boolean;
  output: string;
  /** bash 类命令的真实退出码；ok=false 且无 exitCode 时视为异常路径 */
  exitCode?: number;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput>;
}
