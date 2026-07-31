# validate-encoding

一个 Claude Code 的 **PostToolUse 钩子**:当 `Write` / `Edit` / `MultiEdit` 把中文(或任意非 ASCII)写成乱码(替换字符 U+FFFD)时,自动拦下并指引 Claude **只修出问题的那几行**,而不是重写整个文件。

## 解决什么问题

Claude 偶尔会在写文件时把 CJK 字符写坏,落盘成替换字符 U+FFFD(UTF-8 解码失败的标志)。最朴素的修法是让 Claude 重写整个文件——很费 token,且容易在重写时再次写坏。

这个钩子的杠杆点是:**修复乱码必须重生那段中文(钩子不知道正确内容),所以省 token 的唯一办法是把重生范围压到最小**。它先放行落盘,再从磁盘读真实字节,把含乱码的**整行**作为 `old_string` 回传,Claude 只需复制该行 + 写正确的 `new_string`,一次只重生一行。

## 工作原理

- 作为 `PostToolUse` 钩子挂在 `Write | Edit | MultiEdit` 上,文件落盘后立即运行。
- 用 UTF-8 读盘,坏字节替换为 U+FFFD(等价 Python 的 `errors="replace"`)。
- **区域限定**(防历史乱码误报死循环):
  - `Write` → 整文件
  - `Edit` → `new_string` 在磁盘的所有落点区间
  - `MultiEdit` → 每个 `edit.new_string` 的所有落点区间
  - 区域**之外**既有的历史 U+FFFD 一律忽略,避免 Claude 改不动 → 死循环。
- 命中 → `exit 2` + stderr,列出每行乱码的磁盘真实字节;干净 → `exit 0` 静默放行;JSON/读盘失败 → `exit 0`(不误伤)。

## 依赖

- **Node.js**(任意较新版本即可)。Claude Code 本身就跑在 Node 上,所以环境里一定有,无需额外装解释器。

## 安装

1. 把 `validate-encoding.js` 放到 `~/.claude/hooks/`(目录不存在就新建)。
2. 在 `~/.claude/settings.json` 里加一个 `PostToolUse` 钩子(与已有钩子并存即可,不要覆盖):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/hooks/validate-encoding.js",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

3. 让 Claude Code 重新加载配置:打开一次 `/hooks` 菜单,或重启会话。

## 跨平台

Windows / macOS / Linux 均可。Node 的 UTF-8 解码器对无效字节的处理与 Python 一致(产出 U+FFFD);Node 的 stderr 默认就是 UTF-8,没有 Windows 控制台代码页(cp936 等)的乱码问题。

> 说明:JS 字符串按 UTF-16 码元索引,与 Python 的码点索引在星平面字符(emoji 等)上有差异;但本钩子提取的是以 `\n` 为界的整行,边界一致,仅超长行(>200 字符)的窗口计算对 emoji 计数略有不同,不影响功能。

## License

Released under the [MIT License](LICENSE) — © 2026 mengtao Liu
