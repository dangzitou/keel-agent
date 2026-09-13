/**
 * 极简 glob -> RegExp（零依赖）。支持 **、*、?。
 * 语义对齐 .gitignore：不含 "/" 的模式会匹配任意层级的 basename。
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const j = i + 2;
        if (glob[j] === '/') {
          re += '(?:.*/)?';
          i = j; // 循环尾部的 i++ 会跳过 '/'
        } else {
          re += '.*';
          i++; // 跳过第二个 '*'
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(glob: string, relPath: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(relPath)) return true;
  if (!glob.includes('/')) {
    const base = relPath.split('/').pop() ?? relPath;
    if (re.test(base)) return true;
  }
  return false;
}

export function anyGlobMatch(globs: string[], relPath: string): boolean {
  return globs.some((g) => globMatch(g, relPath));
}
