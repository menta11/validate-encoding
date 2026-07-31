#!/usr/bin/env node
// PostToolUse hook: 写入落盘后扫描"本次写入区域"里的中文乱码 (U+FFFD),
// 命中则把磁盘真实字节作为 old_string 回传 -> 让 LLM 仅 Edit 修复该行, 不重写整文件。
//
// 设计 (第一性原理):
//   修复乱码必须重生那段中文 (hook 不知正确内容), 省 token 唯一杠杆 = 重生范围最小化。
//   先落盘再校验: 乱码已写入磁盘, hook 直接读磁盘真实字节, 取含乱码的整行当 old_string,
//   LLM 复制该行 + 写正确 new_string -> 只重生一行, 不是整文件/整 new_string。
//
// 区域限定 (防历史乱码误报死循环):
//   Write     -> 整文件 (全新覆盖)
//   Edit      -> new_string 在磁盘的所有落点区间 (只查本次写入)
//   MultiEdit -> 每个 edit.new_string 的所有落点区间
//   不查区外: 避免文件既有的历史 U+FFFD 触发误报 -> Claude 改不动 -> 死循环。
//
// 行为:
//   无 U+FFFD      -> exit 0 (静默放行)
//   命中           -> exit 2 + stderr (文件/处数/每行 old_string 真实字节), 指示最小 Edit
//   JSON/读盘失败  -> exit 0 (不误伤正常流程)
//
// 实现: Node 版 (替代原 bash+python 版)。
//   - Node 随 Claude Code 必然存在, 免去 python 解释器探测 / python3 stub 问题。
//   - Buffer.toString("utf-8") 对无效字节产出 U+FFFD, 等价 python errors="replace"。
//   - process.stderr 默认 UTF-8, 无 Windows 控制台代码页 (cp936) 乱码问题。
//   注意: JS 字符串按 UTF-16 码元索引; 本钩子提取的是以 \n 为界的整行, 边界一致,
//         仅超长行窗口 (MAXL/Win) 对星平面字符 (emoji) 计数与 python 略有差异, 不影响功能。
"use strict";

const fs = require("fs");

const REPL = String.fromCharCode(0xfffd); // 替换字符: UTF-8 解码失败标志 (用码点构造, 源文件保持纯 ASCII)
const WIN = 40;        // 超长行退化为窗口 (单侧字符数)
const MAXL = 200;      // 行长上限, 超过则用窗口而非整行

// 读取 stdin (hook payload)。读不到/非 JSON -> 静默放行。
let payload;
try {
  payload = JSON.parse(fs.readFileSync(0, "utf-8"));
} catch (e) {
  process.exit(0);
}

const tool = (payload && payload.tool_name) || "";
const ti = (payload && payload.tool_input) || {};
const filePath = ti.file_path || "(未知)";

// 读盘: 坏字节 -> U+FFFD (与 python errors="replace" 等价)。读盘失败 -> 静默放行。
let content;
try {
  content = fs.readFileSync(filePath).toString("utf-8");
} catch (e) {
  process.exit(0);
}

// 本次写入覆盖的 [start,end) 区间 (按 JS 字符串码元下标)
function touchedSpans() {
  const spans = [];
  // new_string 可能在磁盘重复出现, 全部纳入
  function addAll(s) {
    if (!s) return;
    let start = 0;
    while (true) {
      const loc = content.indexOf(s, start);
      if (loc < 0) break;
      spans.push([loc, loc + s.length]);
      start = loc + 1;
    }
  }
  if (tool === "Write") {
    spans.push([0, content.length]); // 全新覆盖
  } else if (tool === "Edit") {
    addAll(ti.new_string || "");
  } else if (tool === "MultiEdit") {
    for (const e of ti.edits || []) addAll(e.new_string || "");
  }
  return spans;
}

const spans = touchedSpans();
if (spans.length === 0) process.exit(0);

function inAny(pos) {
  for (const [a, b] of spans) {
    if (a <= pos && pos < b) return true;
  }
  return false;
}

// 仅本次写入区域内的乱码位置 (区外历史乱码忽略)
const hits = [];
for (let i = 0; i < content.length; i++) {
  if (content[i] === REPL && inAny(i)) hits.push(i);
}
if (hits.length === 0) process.exit(0);

// pos 所在行的 [行首, 行尾) 绝对下标
function lineBounds(pos) {
  const ls = content.lastIndexOf("\n", pos - 1) + 1; // 等价 python rfind("\n",0,pos)
  let le = content.indexOf("\n", pos);
  if (le < 0) le = content.length;
  return [ls, le];
}

// 按所在行聚合 -> 每行一条 Edit (同行多乱码一次修复)
const entries = [];
const seenLine = new Set();
for (const i of hits) {
  const [ls, le] = lineBounds(i);
  if (seenLine.has(ls)) continue;
  seenLine.add(ls);
  const line = content.slice(ls, le);
  let old;
  if (line.length <= MAXL) {
    old = line; // 整行: 磁盘真实字节, 通常全局唯一
  } else {
    old = content.slice(Math.max(ls, i - WIN), Math.min(le, i + WIN + 1)); // 超长行退化: 乱码两侧窗口
  }
  entries.push(old);
}

const lines = [];
lines.push("⚠️  写入内容含中文乱码 (U+FFFD), 已落盘 -> 仅 Edit 修复下面各行, 勿重写整文件");
lines.push("文件: " + filePath);
lines.push("乱码: " + hits.length + " 处 / 涉及: " + entries.length + " 行");
lines.push("");
entries.forEach((old, idx) => {
  lines.push("[" + (idx + 1) + "] old_string (磁盘真实字节, 直接复制, 含乱码):");
  lines.push("<<<");
  lines.push(old);
  lines.push(">>>");
});
lines.push("");
lines.push("做法: 每条 Edit, old_string=<<<与>>>之间的原文, new_string=重写正确的中文。");
lines.push("若 old_string 不唯一或匹配失败, 向两侧扩展上下文再试。");
process.stderr.write(lines.join("\n") + "\n");
process.exit(2);
