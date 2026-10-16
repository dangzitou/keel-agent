import fs from 'node:fs';
import path from 'node:path';
import { keelHome } from './core/store.js';

export type ProviderApi = 'openai' | 'anthropic' | 'responses';

export interface ProviderCfg {
  baseURL: string;
  apiKeyEnv: string;
  /** 线协议：openai=chat/completions（默认）、anthropic=messages、responses=OpenAI Responses */
  api?: ProviderApi;
}

export interface PolicyCfg {
  denyPaths: string[];
  bashDeny: string[];
  bashApprove: string[];
  readOnly: boolean;
  /** 禁止读写工作目录之外的路径（默认开启；bash 不受此约束，见 README 安全边界） */
  constrainToWorkspace: boolean;
  /** 可读不可写：write/edit 拒绝；开启沙箱时 bash/verify 同样写不了（默认保护 .keel.json，防止 agent 改自己的策略） */
  protectPaths: string[];
  /** 写入白名单：非空时 write/edit（及沙箱内 bash）只能改这些路径；空 = 工作目录内都可写 */
  writePaths: string[];
  /** 写这些路径需要人工审批（如 package.json、迁移脚本） */
  approvePaths: string[];
}

export type SandboxMode = 'off' | 'workspace-write';

/** bash/verify 的 OS 级沙箱：macOS seatbelt（sandbox-exec）、Linux bubblewrap；要求开启但不可用时拒绝执行（fail closed） */
export interface SandboxCfg {
  mode: SandboxMode;
  /** 是否允许外网（默认禁止；本机 localhost 始终可连） */
  network: boolean;
  /** 额外可写的绝对路径（如 ~/.npm、~/.cache 等工具缓存） */
  writablePaths: string[];
}

export interface HookCfg {
  /** 外部命令：stdin 收到 JSON，exit 0 放行（stdout 可回 {"decision","reason"}），exit 2 拒绝，其它情况一律拒绝 */
  command: string;
  /** 只对这些工具生效；省略 = 全部工具 */
  tools?: string[];
  timeoutMs?: number;
}

export interface HooksCfg {
  /** 工具执行前的外部闸门：只能收紧（allow→approve/deny），不能放宽内置策略；每次判定都落事件 */
  preTool: HookCfg[];
}

export interface LlmCfg {
  /** 瞬态错误（429/5xx/网络）的最大重试次数 */
  retries: number;
  /** 单次请求超时毫秒 */
  timeoutMs: number;
  /** SSE 流式输出（部分兼容网关不支持时可关） */
  stream: boolean;
}

export interface KeelConfig {
  providers: Record<string, ProviderCfg>;
  /** "provider/model"，main 干活、fast 做摘要/标题等辅助 */
  router: { main: string; fast: string };
  budget: { maxUsdPerSession: number; maxTokensPerSession?: number };
  /** USD per million tokens; custom gateways/subscription models can declare their own rates. */
  pricing?: Record<string, { input: number; output: number }>;
  policy: PolicyCfg;
  sandbox: SandboxCfg;
  hooks: HooksCfg;
  llm: LlmCfg;
  /** 完成契约的默认验证命令 */
  verify: { commands: string[] };
  context: { compactThresholdTokens: number; keepRecentMessages: number };
  maxTurns: number;
}

export const DEFAULT_PROVIDERS: Record<string, ProviderCfg> = {
  deepseek: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  zhipu: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKeyEnv: 'ZHIPU_API_KEY' },
  'glm-anthropic': { baseURL: 'https://open.bigmodel.cn/api/anthropic', apiKeyEnv: 'ZHIPU_API_KEY', api: 'anthropic' },
  stepfun: { baseURL: 'https://api.stepfun.com/step_plan/v1', apiKeyEnv: 'STEPFUN_API_KEY', api: 'responses' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1', apiKeyEnv: 'MOONSHOT_API_KEY' },
  qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKeyEnv: 'DASHSCOPE_API_KEY' },
  openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
};

export function defaultConfig(): KeelConfig {
  return {
    providers: { ...DEFAULT_PROVIDERS },
    router: { main: 'deepseek/deepseek-chat', fast: 'deepseek/deepseek-chat' },
    budget: { maxUsdPerSession: 5, maxTokensPerSession: 1_000_000 },
    policy: {
      denyPaths: ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '.git/**', '.keel/**'],
      bashDeny: ['rm -rf /', 'rm -rf /*', 'sudo *', 'shutdown*', 'mkfs*', 'dd if=*'],
      bashApprove: ['git push*', 'rm *', 'npm publish*', 'mv * /', 'chmod -R *'],
      readOnly: false,
      constrainToWorkspace: true,
      protectPaths: ['.keel.json'],
      writePaths: [],
      approvePaths: [],
    },
    sandbox: { mode: 'off', network: false, writablePaths: [] },
    hooks: { preTool: [] },
    llm: { retries: 3, timeoutMs: 600_000, stream: true },
    verify: { commands: [] },
    context: { compactThresholdTokens: 48000, keepRecentMessages: 6 },
    maxTurns: 40,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return (override as T) ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error(`非法配置字段: ${k}`);
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export interface LoadedConfig {
  cfg: KeelConfig;
  sources: string[];
}

/** 全局 ~/.keel/config.json 与项目 .keel.json 合并，项目优先；最后应用环境变量直配（最轻量的接入方式） */
export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const defaults = defaultConfig();
  const sources: string[] = [];
  let cfg = defaults;
  let explicitMain = false;
  let explicitFast = false;

  const globalFile = path.join(keelHome(), 'config.json');
  if (fs.existsSync(globalFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(globalFile, 'utf-8'));
      if (!isPlainObject(raw)) throw new Error('配置必须是 JSON 对象');
      explicitMain ||= isPlainObject(raw.router) && 'main' in raw.router;
      explicitFast ||= isPlainObject(raw.router) && 'fast' in raw.router;
      cfg = deepMerge(cfg, raw);
      sources.push(globalFile);
    } catch (e) {
      throw new Error(`解析 ${globalFile} 失败: ${(e as Error).message}`);
    }
  }
  const projectFile = path.join(cwd, '.keel.json');
  if (fs.existsSync(projectFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(projectFile, 'utf-8'));
      if (!isPlainObject(raw)) throw new Error('配置必须是 JSON 对象');
      explicitMain ||= isPlainObject(raw.router) && 'main' in raw.router;
      explicitFast ||= isPlainObject(raw.router) && 'fast' in raw.router;
      cfg = deepMerge(cfg, raw);
      sources.push(projectFile);
    } catch (e) {
      throw new Error(`解析 ${projectFile} 失败: ${(e as Error).message}`);
    }
  }
  validateConfig(cfg);
  const envApplied = applyEnvOverrides(cfg, explicitMain, explicitFast);
  validateConfig(cfg);
  if (envApplied) sources.push('env:KEEL_MODEL');
  return { cfg, sources };
}

/** 各内置 provider 的代表模型：自动选择默认模型时用（同一 env key 只取最靠前的 openai 兼容项） */
const AUTO_MODEL: Array<[provider: string, model: string]> = [
  ['zhipu', 'zhipu/glm-4.6'],
  ['glm-anthropic', 'glm-anthropic/glm-5.3'],
  ['stepfun', 'stepfun/step-5-preview'],
  ['moonshot', 'moonshot/kimi-k2-0711-preview'],
  ['qwen', 'qwen/qwen-plus'],
  ['openai', 'openai/gpt-4o-mini'],
];

/**
 * 易用性默认值：仅当 router 仍是出厂默认（deepseek/deepseek-chat）且其 key 不在时，
 * 自动切到环境里有 key 的内置 provider（多个在场时按上表优先级取第一个）——
 * "export 一个 key 即用"。任何显式配置（.keel.json / config.json / KEEL_MODEL）都优先于它。
 */
export function autoModelFromEnv(providers: Record<string, ProviderCfg>, defaultMain: string): string | null {
  if (defaultMain !== 'deepseek/deepseek-chat') return null; // 用户已显式选择，不越权
  if (process.env.DEEPSEEK_API_KEY) return null;
  for (const [name, model] of AUTO_MODEL) {
    const pcfg = providers[name];
    if (pcfg && process.env[pcfg.apiKeyEnv]) return model;
  }
  return null;
}

/**
 * 环境变量直配（优先级最高，零配置文件）：
 *   KEEL_MODEL=stepfun/step-5-preview          内置 provider 直接引用
 *   KEEL_MODEL=my-model KEEL_BASE_URL=... KEEL_API_KEY=... KEEL_API=anthropic|responses|openai
 *   KEEL_FAST_MODEL=...                         可选，压缩等辅助调用
 */
function applyEnvOverrides(cfg: KeelConfig, explicitMain = false, explicitFast = false): boolean {
  const resolve = (ref: string): string | null => {
    const v = process.env[ref]?.trim();
    if (!v) return null;
    const slash = v.indexOf('/');
    const providerName = slash > 0 ? v.slice(0, slash) : '';
    if (providerName && cfg.providers[providerName]) return v; // 内置/已配置 provider
    // 未知 provider：挂到 env provider 上，模型名取斜杠后段（无斜杠则整串）
    if (!cfg.providers.env) {
      if (process.env.KEEL_API && !['openai', 'anthropic', 'responses'].includes(process.env.KEEL_API)) throw new Error('KEEL_API 必须是 openai、anthropic 或 responses');
      const api = (['openai', 'anthropic', 'responses'] as const).includes(process.env.KEEL_API as 'openai')
        ? (process.env.KEEL_API as ProviderApi)
        : 'openai';
      cfg.providers.env = {
        baseURL: process.env.KEEL_BASE_URL?.trim() || 'https://api.openai.com/v1',
        apiKeyEnv: 'KEEL_API_KEY',
        api,
      };
    }
    return `env/${slash > 0 ? v.slice(slash + 1) : v}`;
  };
  const main = resolve('KEEL_MODEL');
  if (main) cfg.router.main = main;
  const fast = resolve('KEEL_FAST_MODEL');
  if (fast) cfg.router.fast = fast;
  else if (main && !explicitFast) cfg.router.fast = main;
  if (!main && !fast) {
    const auto = explicitMain ? null : autoModelFromEnv(cfg.providers, cfg.router.main);
    if (auto) {
      cfg.router.main = auto;
      if (!explicitFast) cfg.router.fast = auto;
    }
    return Boolean(auto);
  }
  return true;
}

export function validateConfig(cfg: KeelConfig): void {
  const require = (ok: boolean, field: string) => { if (!ok) throw new Error(`配置 ${field} 不合法`); };
  for (const field of ['providers', 'router', 'budget', 'policy', 'sandbox', 'hooks', 'llm', 'verify', 'context'] as const) require(isPlainObject(cfg[field]), field);
  const number = (v: unknown, field: string, min: number, integer = true) => require(typeof v === 'number' && Number.isFinite(v) && v >= min && (!integer || Number.isSafeInteger(v)), field);
  number(cfg.maxTurns, 'maxTurns', 1);
  number(cfg.llm.retries, 'llm.retries', 0);
  number(cfg.llm.timeoutMs, 'llm.timeoutMs', 1);
  require(cfg.llm.timeoutMs <= 2_147_483_647, 'llm.timeoutMs');
  require(typeof cfg.llm.stream === 'boolean', 'llm.stream');
  number(cfg.context.compactThresholdTokens, 'context.compactThresholdTokens', 1);
  number(cfg.context.keepRecentMessages, 'context.keepRecentMessages', 1);
  number(cfg.budget.maxUsdPerSession, 'budget.maxUsdPerSession', 0, false);
  if (cfg.budget.maxTokensPerSession !== undefined) number(cfg.budget.maxTokensPerSession, 'budget.maxTokensPerSession', 0);
  for (const field of ['readOnly', 'constrainToWorkspace'] as const) require(typeof cfg.policy[field] === 'boolean', `policy.${field}`);
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string' && !!s.trim());
  for (const field of ['denyPaths', 'bashDeny', 'bashApprove', 'protectPaths', 'writePaths', 'approvePaths'] as const) require(strings(cfg.policy[field]), `policy.${field}`);
  require(['off', 'workspace-write'].includes(cfg.sandbox.mode), 'sandbox.mode');
  require(typeof cfg.sandbox.network === 'boolean', 'sandbox.network');
  require(strings(cfg.sandbox.writablePaths) && cfg.sandbox.writablePaths.every((p) => path.isAbsolute(p)), 'sandbox.writablePaths');
  require(Array.isArray(cfg.hooks.preTool), 'hooks.preTool');
  cfg.hooks.preTool.forEach((hook, i) => {
    require(isPlainObject(hook) && typeof hook.command === 'string' && !!hook.command.trim(), `hooks.preTool[${i}].command`);
    if (hook.tools !== undefined) require(strings(hook.tools), `hooks.preTool[${i}].tools`);
    if (hook.timeoutMs !== undefined) number(hook.timeoutMs, `hooks.preTool[${i}].timeoutMs`, 1);
  });
  require(Array.isArray(cfg.verify.commands) && cfg.verify.commands.every((s) => typeof s === 'string' && !!s.trim()), 'verify.commands');
  for (const [name, provider] of Object.entries(cfg.providers)) {
    require(isPlainObject(provider), `providers.${name}`);
    require(typeof provider.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(provider.apiKeyEnv), `providers.${name}.apiKeyEnv`);
    require(!provider.api || ['openai', 'anthropic', 'responses'].includes(provider.api), `providers.${name}.api`);
    let url: URL;
    try { url = new URL(provider.baseURL); } catch { throw new Error(`配置 providers.${name}.baseURL 不合法`); }
    require(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, `providers.${name}.baseURL`);
  }
  for (const role of ['main', 'fast'] as const) {
    const ref = cfg.router[role];
    require(typeof ref === 'string' && ref.indexOf('/') > 0 && !!ref.slice(ref.indexOf('/') + 1).trim() && !!cfg.providers[ref.slice(0, ref.indexOf('/'))], `router.${role}`);
  }
  if (cfg.pricing !== undefined) {
    require(isPlainObject(cfg.pricing), 'pricing');
    for (const [model, rate] of Object.entries(cfg.pricing)) {
      require(isPlainObject(rate), `pricing.${model}`);
      number(rate.input, `pricing.${model}.input`, 0, false);
      number(rate.output, `pricing.${model}.output`, 0, false);
    }
  }
}

export function configTemplate(): string {
  const d = defaultConfig();
  return JSON.stringify(
    {
      ...d,
      router: { main: 'deepseek/deepseek-chat', fast: 'deepseek/deepseek-chat' },
      verify: { commands: ['npm test'] },
      _说明: {
        providers: '内置 deepseek/zhipu/glm-anthropic/stepfun/moonshot/qwen/openai；api 指定线协议(openai|anthropic|responses)；apiKeyEnv 指定从哪个环境变量读密钥',
        router: '格式 provider/model；main 干活，fast 做上下文压缩等便宜活；也可用环境变量 KEEL_MODEL/KEEL_BASE_URL/KEEL_API_KEY/KEEL_API 直配（优先级最高）',
        llm: 'retries=瞬态错误重试次数；timeoutMs=单请求超时；stream=流式输出',
        verify: '完成契约的默认验证命令，agent 修改文件后必须跑通才能声明完成',
        policy: 'denyPaths 拦路径（读和写都拦）；protectPaths 可读不可写；writePaths 写入白名单；approvePaths 写入需审批；constrainToWorkspace 禁止出工作目录；bashDeny 直接拒绝；bashApprove 需人工确认',
        sandbox: 'mode=workspace-write 时 bash/verify 跑在 OS 沙箱里：只能写工作目录与临时目录，读不到 denyPaths 与 keel 事件库，network=false 断外网',
        hooks: 'preTool: [{ command, tools? }]，工具执行前调用外部命令，stdin 为 JSON；exit 0 放行、exit 2 拒绝，只能收紧不能放宽',
      },
    },
    null,
    2,
  );
}

export function initConfig(): string {
  const file = path.join(keelHome(), 'config.json');
  if (fs.existsSync(file)) return `已存在: ${file}`;
  fs.mkdirSync(keelHome(), { recursive: true });
  fs.writeFileSync(file, configTemplate(), 'utf8');
  return file;
}
