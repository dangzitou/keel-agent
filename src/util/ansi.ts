/** 零依赖 ANSI 颜色与终端小工具 */

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: string, s: string): string {
  return enabled ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const ansi = {
  bold: (s: string) => wrap('1', s),
  dim: (s: string) => wrap('2', s),
  red: (s: string) => wrap('31', s),
  green: (s: string) => wrap('32', s),
  yellow: (s: string) => wrap('33', s),
  blue: (s: string) => wrap('34', s),
  magenta: (s: string) => wrap('35', s),
  cyan: (s: string) => wrap('36', s),
};

/** 清除当前行（spinner 用） */
export function clearLine(stream: NodeJS.WriteStream = process.stderr): void {
  if (stream.isTTY) stream.write('\r\x1b[2K');
}
