import { KeelConfig } from '../config.js';
import { SessionStore } from '../core/store.js';
import { FileChange } from '../events/types.js';

export interface ToolCtx {
  cwd: string;
  cfg: KeelConfig;
  store: SessionStore;
  interactive: boolean;
  /** 用户中断信号：bash 等长操作应响应 */
  signal?: AbortSignal;
  /** The loop has approved this invocation, including verify's nested commands. */
  approved?: boolean;
}

export interface ToolOutput {
  ok: boolean;
  output: string;
  /** bash 类命令的真实退出码；ok=false 且无 exitCode 时视为异常路径 */
  exitCode?: number;
  /** write/edit 的内容快照（检查点），由 loop 记为 file.changed 事件 */
  changes?: FileChange[];
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(input: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput>;
}
