---
description: Show or change the ZCode appearance (background pictures or videos, where they show, tint, blur, rotation, colour skin) by updating the appearance settings; the launcher applies them without restarting ZCode.
argument-hint: "[要求，留空则显示当前设置。例如：只换会话区，遮罩 0.7 | 背景换成 D:\\Wallpapers\\a.jpg | 换成 midnight 皮肤]"
---

Change how the ZCode desktop window looks through the `appearance` plugin.

The plugin's MCP server exposes two tools. Their model-visible names carry the
plugin namespace, so they look like:

- `mcp__plugin_appearance_style__get_appearance`
- `mcp__plugin_appearance_style__set_appearance`

If those exact names are not in your tool list, find the tools whose name ends in
`__get_appearance` / `__set_appearance` and use those.

## Usage

```text
/appearance
/appearance 背景换成 E:\Wallpapers\a.jpg
/appearance 只换会话区，遮罩 0.7
/appearance 整页，模糊 4，每 30 分钟换一个，再加上 D:\Clips\b.mp4
/appearance 把第二个去掉
/appearance 关掉背景
/appearance 换成 midnight 皮肤
/appearance 自定义皮肤，深色底 #101418、卡片 #181d25、文字 #e6e6e6、强调色 #38bdf8、边框 #2a303a
```

## What to do

1. With no arguments, call `get_appearance` and report what it returns.
2. Turn the request into `set_appearance` fields and send them in one call:

   | The user says | Field |
   |---|---|
   | 整页 / 整个页面 / 全部 | `scope: "page"` |
   | 只换会话区 / 对话区 / 聊天区 | `scope: "chat"` (pictures only: a video cannot paint the conversation area) |
   | 遮罩 | `mask`, 0 to 1 |
   | 模糊 N | `blur` |
   | 每 N 分钟换一个 | `rotateMinutes` |
   | 背景换成 / 用某个文件 | `setMedia` (replaces the list) |
   | 加上 / 再加一个 | `addMedia` |
   | 去掉 / 不要某个 | `removeMedia`, by path or by its number in the list |
   | 关掉背景 / 不要背景 | `enabled: false` |
   | 换成某套皮肤 | `skin` |
   | 自定义皮肤 / 自己配色 | `skin: "default"` plus `customSkin` |

   Keep the user's file path as they wrote it unless it is relative, in which case
   resolve it against the workspace. Do not write the settings file yourself: the
   tools validate every change and report what is wrong with a bad one.
3. Report what changed, the settings file path, and the launcher state from the
   tool's reply. When it says the launcher is not running, tell the user the change
   is saved and will show the next time ZCode is started from the launcher (ZCode
   has to be quit completely first, tray icon included). For anything more than a
   quick change, the side-pane view ("Appearance", under Extensions in the side
   bar) shows every setting as a control that applies at once.
4. Relay an error from the tool as it is (unknown field, missing file, wrong
   colour format) and say what to change.
