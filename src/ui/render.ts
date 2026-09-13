import rlPromises from 'node:readline/promises';
import { Event } from '../events/types.js';
import { ansi, clearLine } from '../util/ansi.js';
import { bareModel, hasKnownPrice } from '../llm/cost.js';

export interface Ui {
  assistantText(text: string | null): void;
  toolStart(name: string, input: Record<string, unknown>): void;
  toolResult(ok: boolean, output: string, durationMs: number): void;
  note(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  policyDenied(tool: string, rule: string | null): void;
  spinStart(label: string): void;
  spinStop(): void;
  approve(prompt: string): Promise<boolean>;
  status(text: string): void;
}

function argHint(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'bash':
      return String(input.command ?? '');
    case 'write':
    case 'edit':
    case 'read':
      return String(input.path ?? '');
    case 'glob':
      return String(input.pattern ?? '');
    case 'grep':
      return String(input.pattern ?? '');
    case 'verify':
      return Array.isArray(input.commands) ? (input.commands as string[]).join(' && ') : '(配置命令)';
    default:
      return JSON.stringify(input).slice(0, 120);
  }
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class TerminalUi implements Ui {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;

  assistantText(text: string | null): void {
    if (text?.trim()) console.log(text.trim());
  }

  toolStart(name: string, input: Record<string, unknown>): void {
    this.spinStop();
    console.log(`${ansi.cyan('●')} ${ansi.bold(name)} ${ansi.dim(argHint(name, input).split('\n')[0]!.slice(0, 160))}`);
  }

  toolResult(ok: boolean, output: string, durationMs: number): void {
    const lines = output.split('\n').filter(Boolean);
    const mark = ok ? ansi.dim('↳') : ansi.red('✗');
    const head = lines.slice(0, ok ? 4 : 6);
    for (const l of head) console.log(`${mark} ${ansi.dim(l.slice(0, 240))}`);
    if (lines.length > head.length) console.log(`${mark} ${ansi.dim(`… +${lines.length - head.length} 行`)}`);
    console.log(ansi.dim(`  (${durationMs}ms)`));
  }

  note(text: string): void {
    this.spinStop();
    console.log(ansi.dim(`· ${text}`));
  }

  warn(text: string): void {
    this.spinStop();
    console.log(ansi.yellow(`! ${text}`));
  }

  error(text: string): void {
    this.spinStop();
    console.log(ansi.red(`✗ ${text}`));
  }

  policyDenied(tool: string, rule: string | null): void {
    this.spinStop();
    console.log(ansi.red(`⊘ ${tool} 被策略拦截${rule ? `（${rule}）` : ''}`));
  }

  spinStart(label: string): void {
    this.spinStop();
    if (!process.stderr.isTTY) return;
    this.frame = 0;
    this.timer = setInterval(() => {
      clearLine();
      process.stderr.write(`${ansi.cyan(FRAMES[this.frame % FRAMES.length]!)} ${label}`);
      this.frame += 1;
    }, 120);
  }

  spinStop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      clearLine();
    }
  }

  async approve(prompt: string): Promise<boolean> {
    this.spinStop();
    const rl = rlPromises.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`${ansi.yellow('?')} ${prompt} ${ansi.dim('[y/N] ')}`);
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
  }

  status(text: string): void {
    console.log(ansi.dim(text));
  }
}

/** 测试与非交互场景用：只记录不打印 */
export class QuietUi implements Ui {
  logs: string[] = [];
  approveAnswer = false;

  private log(s: string): void {
    this.logs.push(s);
  }
  assistantText(text: string | null): void {
    if (text?.trim()) this.log(`assistant: ${text}`);
  }
  toolStart(name: string): void {
    this.log(`tool: ${name}`);
  }
  toolResult(ok: boolean, output: string): void {
    this.log(`result(${ok}): ${output.slice(0, 120)}`);
  }
  note(text: string): void {
    this.log(`note: ${text}`);
  }
  warn(text: string): void {
    this.log(`warn: ${text}`);
  }
  error(text: string): void {
    this.log(`error: ${text}`);
  }
  policyDenied(tool: string, rule: string | null): void {
    this.log(`denied: ${tool} ${rule ?? ''}`);
  }
  spinStart(): void {}
  spinStop(): void {}
  async approve(): Promise<boolean> {
    return this.approveAnswer;
  }
  status(text: string): void {
    this.log(text);
  }
}

/** 会话状态行 */
export function statusLine(sessionId: string, stopReason: string, spendUsd: number, model: string): string {
  const priceNote = hasKnownPrice(model) ? '' : '（模型无价目，费用未计入）';
  return `会话 ${sessionId.slice(-10)} · ${stopReason} · 累计 $${spendUsd.toFixed(4)} · ${bareModel(model)}${priceNote}`;
}

/** 回放：把任意一条事件渲染成一行（确定性，读事件即可重建整个会话的画面） */
export function renderEventLine(e: Event): string {
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case 'session.started':
      return ansi.dim(`▶ 会话开始 · cwd=${d.cwd} · 模型=${d.model}${e.parent ? ` · fork 自 ${e.parent}@${e.forkedAtSeq}` : ''}`);
    case 'user.message':
      return `\n${ansi.bold('【用户】')} ${d.text}`;
    case 'system.note':
      return ansi.yellow(`【harness】${d.text}`);
    case 'llm.request':
      return ansi.dim(`→ ${d.role} 请求 ${d.model}（${d.messageCount} 条消息，工具: ${(d.tools ?? []).join('/')}）`);
    case 'llm.response': {
      const parts: string[] = [];
      if (d.content) parts.push(d.content);
      for (const tc of d.toolCalls ?? []) parts.push(`⚙ ${tc.name}(${(tc.arguments ?? '').slice(0, 160)})`);
      const head = ansi.bold('【Keel】');
      const meta = ansi.dim(`　↑${d.usage?.inputTokens ?? 0} ↓${d.usage?.outputTokens ?? 0} tok · $${(d.costUsd ?? 0).toFixed(4)} · ${d.latencyMs ?? 0}ms`);
      return `${head} ${parts.join('\n  ') || '(无输出)'}${meta}`;
    }
    case 'policy.decision':
      if (d.decision === 'allow') return ansi.dim(`  策略: allow ${d.tool}`);
      return ansi[d.decision === 'deny' ? 'red' : 'yellow'](`  策略: ${d.decision} ${d.tool}${d.rule ? `（${d.rule}）` : ''}`);
    case 'tool.call':
      return ''; // 已在 llm.response 的工具调用里展示，回放时跳过
    case 'tool.result': {
      const first = String(d.output ?? '').split('\n').slice(0, 3).join(' ⏎ ');
      return `${d.ok ? ansi.dim('  ↳') : ansi.red('  ✗')} ${ansi.dim(`${d.tool} · ${d.durationMs}ms · ${first.slice(0, 200)}`)}`;
    }
    case 'verify.started':
      return ansi.dim(`⧗ 验证: ${(d.commands ?? []).join(' && ')}`);
    case 'verify.result':
      return d.ok ? ansi.green(`✓ 验证通过`) : ansi.red(`✗ 验证失败`);
    case 'context.compacted':
      return ansi.dim(`▢ 上下文压缩至事件 ${d.upToSeq}`);
    case 'turn.completed':
      return ansi.dim(`—— 回合结束 · ${d.stopReason} · 累计 $${(d.spendUsd ?? 0).toFixed(4)}`);
    case 'budget.exceeded':
      return ansi.red(`预算熔断：$${d.spentUsd} / 上限 $${d.capUsd}`);
    case 'error':
      return ansi.red(`错误[${d.where}]: ${d.message}`);
    default:
      return ansi.dim(`(${e.type})`);
  }
}
