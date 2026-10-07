import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { ToolCtx, ToolDef, ToolOutput } from './types.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.keel', '__pycache__', '.venv', 'venv', '.next']);
const MAX_OUTPUT = 10_000;

export function truncateOutput(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.floor(max * 0.4)) + `\n…[输出已截断，全长 ${s.length} 字符]…\n` + s.slice(-Math.floor(max * 0.55));
}

export function resolveIn(ctx: ToolCtx, p: string): string {
  return path.resolve(ctx.cwd, p);
}

function relIn(ctx: ToolCtx, abs: string): string {
  const rel = path.relative(ctx.cwd, abs);
  return rel && !rel.startsWith('..') ? rel : abs;
}

function err(msg: string): ToolOutput {
  return { ok: false, output: msg };
}

async function walk(root: string, cb: (abs: string) => void, depth = 0): Promise<void> {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    const abs = path.join(root, d.name);
    if (d.isDirectory()) {
      if (SKIP_DIRS.has(d.name) || d.isSymbolicLink()) continue;
      await walk(abs, cb, depth + 1);
    } else if (d.isFile()) {
      cb(abs);
    }
  }
}

export const readTool: ToolDef = {
  name: 'read',
  description: '读取文件内容（带行号）。支持 offset/limit 分段读大文件。受 denyPaths 策略约束。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对当前目录或绝对路径）' },
      offset: { type: 'integer', description: '起始行（1 起），默认 1' },
      limit: { type: 'integer', description: '读取行数，默认 2000' },
    },
    required: ['path'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const abs = resolveIn(ctx, String(input.path));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return err(`文件不存在: ${relIn(ctx, abs)}`);
    }
    if (stat.isDirectory()) {
      const items = fs.readdirSync(abs).slice(0, 200);
      return { ok: true, output: `目录 ${relIn(ctx, abs)} 包含:\n${items.join('\n')}` };
    }
    if (stat.size > 2_000_000) return err(`文件过大 (${stat.size} 字节)，请用 bash 处理`);
    const raw = fs.readFileSync(abs, 'utf8');
    const lines = raw.split('\n');
    const offset = Math.max(1, Number(input.offset) || 1);
    const limit = Math.min(2000, Math.max(1, Number(input.limit) || 2000));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice.map((l, i) => `${offset + i}| ${l.slice(0, 2000)}`).join('\n');
    const more = lines.length > offset - 1 + limit ? `\n…[共 ${lines.length} 行，已截断]` : '';
    return { ok: true, output: truncateOutput(body + more) };
  },
};

export const writeTool: ToolDef = {
  name: 'write',
  description: '写入（创建或覆盖）文件。会自动创建父目录。修改文件前应先 read。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      content: { type: 'string', description: '完整文件内容' },
    },
    required: ['path', 'content'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const abs = resolveIn(ctx, String(input.path));
    const content = String(input.content ?? '');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const existed = fs.existsSync(abs);
    fs.writeFileSync(abs, content, 'utf8');
    const n = content ? content.split('\n').length : 0;
    return { ok: true, output: `${existed ? '覆盖' : '创建'}了 ${relIn(ctx, abs)}（${n} 行，${Buffer.byteLength(content)} 字节）` };
  },
};

export const editTool: ToolDef = {
  name: 'edit',
  description: '精确字符串替换编辑文件。oldText 必须在文件中唯一（除非 replaceAll=true）。修改前应先 read。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目标文件路径' },
      oldText: { type: 'string', description: '要替换的原文（需唯一）' },
      newText: { type: 'string', description: '替换为' },
      replaceAll: { type: 'boolean', description: '替换全部匹配，默认 false' },
    },
    required: ['path', 'oldText', 'newText'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const abs = resolveIn(ctx, String(input.path));
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch {
      return err(`文件不存在: ${relIn(ctx, abs)}（edit 不创建新文件，请用 write）`);
    }
    const oldText = String(input.oldText ?? '');
    const newText = String(input.newText ?? '');
    if (!oldText) return err('oldText 不能为空');
    const count = raw.split(oldText).length - 1;
    if (count === 0) return err(`oldText 在 ${relIn(ctx, abs)} 中未找到`);
    if (count > 1 && !input.replaceAll) {
      return err(`oldText 匹配了 ${count} 处，需先扩大上下文使其唯一，或设置 replaceAll=true`);
    }
    const replaced = input.replaceAll ? raw.replaceAll(oldText, newText) : raw.replace(oldText, newText);
    fs.writeFileSync(abs, replaced, 'utf8');
    const n = input.replaceAll ? count : 1;
    return { ok: true, output: `编辑了 ${relIn(ctx, abs)}（${n} 处替换，${raw.split('\n').length} → ${replaced.split('\n').length} 行）` };
  },
};

export const bashTool: ToolDef = {
  name: 'bash',
  description: '在当前目录执行 bash 命令（stdout/stderr 合并返回）。受 bashDeny/bashApprove 策略约束。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      timeoutMs: { type: 'integer', description: '超时毫秒数，默认 120000，上限 600000' },
    },
    required: ['command'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const command = String(input.command ?? '');
    const timeoutMs = Math.min(600_000, Math.max(1000, Number(input.timeoutMs) || 120_000));
    return new Promise((resolve) => {
      // detached 建独立进程组：超时/中断时整组杀死，避免孙进程泄漏
      const child = spawn('/bin/bash', ['-c', command], { cwd: ctx.cwd, env: process.env, detached: true });
      let out = '';
      let capped = false;
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      const collect = (decoder: StringDecoder) => (chunk: Buffer) => {
        if (out.length >= 200_000) {
          capped = true;
          return;
        }
        out += decoder.write(chunk);
      };
      const flush = (decoder: StringDecoder) => {
        const tail = decoder.end();
        if (!tail) return;
        if (out.length >= 200_000) {
          capped = true;
          return;
        }
        out += tail;
      };
      child.stdout.on('data', collect(stdoutDecoder));
      child.stderr.on('data', collect(stderrDecoder));
      child.stdout.on('end', () => flush(stdoutDecoder));
      child.stderr.on('end', () => flush(stderrDecoder));
      const killTree = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(killTree, timeoutMs);
      const onAbort = () => killTree();
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
      };
      child.on('close', (code, signal) => {
        cleanup();
        if (capped) out += '\n…[输出超上限 200k 字符，已截断]…';
        const tail = truncateOutput(out);
        const status = signal ? `信号 ${signal} 终止${signal === 'SIGKILL' ? '（超时或被中断）' : ''}` : `exit ${code}`;
        resolve({
          ok: code === 0 && !signal && !(ctx.signal?.aborted ?? false),
          output: tail ? `${tail}\n[${status}]` : `[${status}]`,
          exitCode: signal ? -1 : (code ?? -1),
        });
      });
      child.on('error', (e) => {
        cleanup();
        resolve(err(`无法启动进程: ${e.message}`));
      });
    });
  },
};

export const globTool: ToolDef = {
  name: 'glob',
  description: '按 glob 模式（支持 **、*、?）查找文件，返回相对路径列表。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: "如 'src/**/*.ts'、'*.json'、'**/*.md'" },
      path: { type: 'string', description: '起始目录，默认当前目录' },
    },
    required: ['pattern'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    const { globToRegExp } = await import('../util/glob.js');
    const re = globToRegExp(String(input.pattern));
    const root = resolveIn(ctx, String(input.path ?? '.'));
    const hits: string[] = [];
    await walk(root, (abs) => {
      if (hits.length >= 500) return;
      const rel = relIn(ctx, abs);
      if (re.test(rel)) hits.push(rel);
    });
    return {
      ok: true,
      output: hits.length ? hits.join('\n') + (hits.length >= 500 ? '\n…[已截断到 500 条]' : '') : '无匹配文件',
    };
  },
};

export const grepTool: ToolDef = {
  name: 'grep',
  description: '在目录内递归按正则搜索文本，返回 file:line: content。默认忽略 .git/node_modules 等。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式' },
      path: { type: 'string', description: '搜索目录，默认当前目录' },
      glob: { type: 'string', description: '只搜匹配该 glob 的文件名，如 *.ts' },
      ignoreCase: { type: 'boolean', description: '忽略大小写，默认 true' },
    },
    required: ['pattern'],
  },
  run: async (input, ctx): Promise<ToolOutput> => {
    let re: RegExp;
    try {
      re = new RegExp(String(input.pattern), input.ignoreCase === false ? '' : 'i');
    } catch (e) {
      return err(`正则无效: ${(e as Error).message}`);
    }
    const fileRe = input.glob ? (await import('../util/glob.js')).globToRegExp(String(input.glob)) : null;
    const root = resolveIn(ctx, String(input.path ?? '.'));
    const hits: string[] = [];
    await walk(root, (abs) => {
      if (hits.length >= 200) return;
      if (fileRe && !fileRe.test(path.basename(abs))) return;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        return;
      }
      if (stat.size > 2_000_000) return;
      let text: string;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        return;
      }
      if (text.slice(0, 8000).includes('\0')) return; // 二进制文件
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < 200; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${relIn(ctx, abs)}:${i + 1}: ${lines[i]!.slice(0, 240)}`);
        }
      }
    });
    return {
      ok: true,
      output: hits.length ? hits.join('\n') + (hits.length >= 200 ? '\n…[已截断到 200 条]' : '') : '无匹配',
    };
  },
};
