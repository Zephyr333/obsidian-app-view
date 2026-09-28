# Quick View (速查版)

[English](#english) | [中文说明](#中文说明)

---

<span id="english"></span>

## Overview

**Quick View** extracts and projects marked sections from your notes into a clean, read-only view in the exact order of the original note. Your full note remains the single source of truth, while editing stays native to Live Preview.

- **Native In-place Toggle**: Click the header action icon (`zap` / `file-text`) to switch in-place between Detailed view and Quick View. `Ctrl/Cmd + Click` opens in a new tab; `Ctrl + Alt + Click` opens in a split pane for side-by-side comparison.
- **State Memory**: Remembers the last viewed state for each note independently across restarts and file navigation.
- **Smart Range Selection**: Select text or right-click headings, list items, callouts, or tables to include entire blocks with zero manual fence typing.
- **Interactive Checklists**: Toggle tasks (`- [ ]` / `- [x]`) directly within the read-only projection; changes write atomically back to the source Markdown.
- **Bi-directional Navigation**: Smoothly jump from any projected section back to its exact line in the editor with high-precision highlighting.
- **Pure Local & Zero Lock-in**: Ranges are stored cleanly as comments (`%%app%% ... %%/app%%`) inside your note, requiring no external databases, servers, or lock-in.

---

## Installation

### From Community Plugins (Recommended once listed)
1. In Obsidian, open **Settings** → **Community plugins**.
2. Turn off **Restricted mode** if enabled.
3. Click **Browse** and search for `Quick View`.
4. Click **Install**, and then **Enable**.

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the [Latest Release](https://github.com/Zephyr333/obsidian-app-view/releases/latest).
2. Open your vault's plugins folder: `<vault>/.obsidian/plugins/`.
3. Create a folder named `app-view` and copy the three files into it.
4. Reload Obsidian, go to **Settings** → **Community plugins**, and enable **Quick View**.

---

## Usage

### 1. Toggle Views
- **Header Icon**: Click the `zap` (or `file-text`) icon in the leaf header to switch between Detailed view and Quick View.
  - **Left Click**: In-place switch in the current tab without creating extra tabs.
  - **Middle Click or `Ctrl/Cmd + Left Click`**: Open Quick View in a new tab.
  - **`Ctrl + Alt + Left Click`**: Open Quick View in a split pane side-by-side.

### 2. Mark & Adjust Ranges
- **Right-click Header Icon**: Right-click the header icon at any time to enter or exit range adjustment mode.
- **Right-click in Editor**:
  - **With Selection**: Select text and right-click to choose "Add to Quick View" (or "Remove from Quick View").
  - **Without Selection**: Right-click inside any heading, list item, blockquote, callout, table, or code block to intelligently include that entire block structure.

### 3. Manage Ranges Directly
- Right-click the header icon while viewing Quick View to enter inline management mode.
- Each section displays a `[Remove this section]` action button, and a floating management bar appears at the bottom.

### 4. Interactive Tasks
- Toggle `- [ ]` and `- [x]` checkboxes directly within Quick View. Changes are atomically synchronized back to the source Markdown note.

### 5. Jump to Source
- Hover over any section in Quick View and click the `arrow-up-right` icon (or double-click the section) to switch back to Live Preview and smoothly highlight that exact line in the editor.

---

## Storage & Syntax

Marked sections are stored directly in your Markdown note as top-level comments:

```markdown
Detailed notes that only appear in Detailed view.

%%app%%
## Action Items
- [ ] Review documentation
- [x] Submit release
%%/app%%

Additional comprehensive explanations.
```

When the plugin is disabled, your notes remain clean standard Markdown.

---

## Settings

- **Display Name**: Customize the name shown in the UI, headers, and commands (default: "Quick View" / "速查版").
- **Block Spacing**: Option to preserve or collapse blank line gaps between consecutive blocks.

---

<span id="中文说明"></span>

## 中文说明

详细版是唯一正文。选择范围，得到按原文顺序排列、自动更新的纯净只读速查视图。编辑始终留在 Live Preview。

### 安装

当前版本：1.0.8。最低 Obsidian 版本设为 **1.13.7**。

1. 在 Releases 中下载 `main.js`、`manifest.json`、`styles.css`。
2. 将文件放入目标库的插件目录：`<你的库>/.obsidian/plugins/app-view/`。
3. 在 Obsidian 设置 → 第三方插件中启用“Quick View / 速查版”。必要时重新加载 Obsidian。
4. 电脑和手机分别安装并启用。正文通过你已有的方式同步；插件不提供额外同步服务。

### 使用指南

- **双态切换（对齐原生）**：
  - 点击笔记右上角顶栏图标（`zap` 闪电 / `file-text` 文档）在详细版与速查版之间切换。
  - **普通左键**：当前标签页**原地直接切换**，不产生多余标签页；
  - **中键 或 `Ctrl/Cmd + 左键`**：在**新标签页**中打开；
  - **`Ctrl + Alt + 左键`**：在**相邻分栏**（新标签组）中打开对比。
- **状态记忆**：自动记录每篇笔记最后停留的视图状态。重新打开笔记时，自动以最后状态（详细版或速查版）呈现；若笔记无标记内容，自动降级打开详细版。
- **调整范围与智能块级收录（零常驻污染，极简交互）**：
  - **直接右键顶栏图标**：无论在详细版还是速查版，直接右键顶栏图标进入／退出范围调整与管理模式。
  - **右键编辑区（智能结构匹配）**：
    - 选中文本右键：显示“加入速查版”（若选区已在范围内则显示“移除速查版”）；
    - 未选文本右键：自动根据光标所在位置智能识别结构边界（如“加入当前章节 (N级标题及下属内容)”、“加入当前列表项 (含子项)”、“加入当前引用块”、“加入当前代码块”、“加入当前表格”或“加入当前段落”），免除手动繁琐选区；
    - 空白处或已在范围内的段落：显示“调整速查版范围”或“移除速查版”。
  - **速查版内直接管理**：在速查版右键顶栏图标直接进入管理态，每个已收录段落顶端出现 `[移除本段]` 按钮，底部浮现管理胶囊，无需切回详细版即可删减。
- **双向位置锚接与溯源跳转**：
  - 速查版中每个段落右上角悬浮溯源按钮（`arrow-up-right`），点击或双击段落文本，瞬时平滑切回详细版并定位、高亮选中该行；
  - 详细版切换速查版时，自动根据光标当前位置滚动至最贴近的收录段落。
- **纯净阅读与原生交互能力**：
  - 对标 Obsidian 原生阅读模式：支持原生链接悬浮预览卡片（`link-hover`）；
  - **待办任务复选框双向回写**：在只读速查版中点击 `- [ ]` / `- [x]` 复选框，自动精确定位并原子回写源 Markdown 文件，实时同步源文件状态，兼顾只读透镜与日常打勾操作。
- **分栏与多标签页防冲突状态记忆**：
  - 单标签页切换与打开：记住最后停留状态；
  - 多标签页或左右分栏并存：若同一笔记同时在不同分栏打开（例如左边详细版编辑，右边速查版对照），互不强制覆盖，保护用户分屏工作流。
- **平时编辑**：标记行与换行符整行完全折叠，零多余空行，无圆点干扰。启用原子范围保护，光标移动自动跳过，绝不意外展开或误删。
- **同步**：编辑、撤销或收到文件更新后，已打开的速查视图自动刷新。手机显示已经同步到本机的内容。
- **自定义名称**：可在设置中将默认的“速查版”自定义为“精要版”、“实践版”等称谓。

### 范围存储

范围保存在源 Markdown 中，不额外记录字符偏移或块 ID。标记各自独占一行，位于行首：

```markdown
只在详细版显示的解释。

%%app%%
## 应用时要做的事

- [ ] 检查条件。
- [x] 执行并记录结果。
%%/app%%

继续详细解释。
```

多个范围按原文顺序显示；不自动补标题、改变标题级别或改写正文。不同范围分开渲染，防止无关列表或表格被意外合并。

### 版本能力与边界

- 支持标题、段落、多行内容、完整列表、引用／Callout、表格、代码、公式、图片和内部链接。
- 智能结构识别覆盖标题及其全部子内容、列表项及嵌套子项、Callout、代码块、表格与普通段落；手动划定范围时建议选取完整行。
- 标记必须位于顶层行首。不支持嵌套或重叠范围。代码块、YAML 属性、缩进代码和普通多行注释中的示例标记不参与收录。
- 未闭合、孤立或嵌套标记会显示具体行号和提示，并清空速查版正文，避免把错误范围当作有效结果。
- 脚注和引用式链接的定义需要放在同一个应用范围内；不会自动收集范围外的定义。普通 `[[笔记]]`、行内链接和图片按源笔记路径解析。
- 速查版正文为只读投影，除任务列表复选框可原子回写源文件外，不提供富文本编辑功能。
- 停用插件后，源笔记仍是普通 Markdown；原生阅读视图将边界作为注释隐藏。
