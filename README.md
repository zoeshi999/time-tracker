# 时间记录

一个中文的个人时间记录工具，界面参照番茄Todo：点一张卡片就开始计时，正计时或倒计时都可以；有待办集分组、补记空白时段、日周月年统计图。

和番茄Todo不同的地方：数据可以开放给 AI 直接读取（开通云端以后）。

## 现在的状态：试用版

- 手机端在 `docs/` 目录，通过 GitHub Pages 发布，地址是 https://zoeshi999.github.io/time-tracker/
- 试用期间，记录只存在自己手机的浏览器里，不上传任何地方。
- 在 iPhone 上用 Safari 打开，点「分享」→「添加到主屏幕」，以后从桌面图标打开。
- 建议每周在「我的 → 数据」里导出一次 JSON 备份。清除 Safari 网站数据会把记录一起删掉。

## 以后开通云端

`server/` 里是云端部分的第一版（Cloudflare Workers + D1），提供：

- `/api/sync`：手机端同步
- `/mcp/<密钥>`：给 Claude、Codex、WorkBuddy 用的 MCP 接口，可以查记录、汇总、补记、修改
- `/view/<只读密钥>`：纯文本数据页，给豆包这类只能打开网页的 AI

打算改用腾讯云开发（CloudBase）时，云端部分需要按腾讯云重写，手机端不用动：在「我的 → 云端同步」里填上地址和密钥，手机里已有的记录会自动传上去。

## 数据格式

每条记录：`id`、`startTime`、`endTime`（毫秒时间戳）、`durationMs`、`description`（待办名，或「待办名：备注」）、`area`（工作/生活）、`category`（待办集）、`project`（项目标签）、`source`（timer / pomodoro / manual / ai）。
