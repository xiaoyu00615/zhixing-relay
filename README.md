# Zhixing Relay v0.1.0

给“知行”开发流程使用的本地中继器：

```text
你指定的 ChatGPT 对话
        ↕
Chrome Extension v0.2
        ↕  ws://127.0.0.1:8787
Zhixing Relay (Node.js)
        ↕
WorkBuddy Local Assistant Open API
        ↕
WorkBuddy
```

## V0.1 的边界

V0.1 只自动转发 **普通文本任务**。

不会自动替你批准 WorkBuddy 的工具权限或危险操作。当前 WorkBuddy 中英文 Open API 文档对
`permission_response` 支持描述不一致，因此这一版明确不做自动审批。

## 1. 安装

建议独立放置，不要直接塞进知行主仓库：

```text
D:\Workspace\
├─ zhixing\
└─ zhixing-relay\
```

进入目录：

```powershell
cd D:\Workspace\zhixing-relay
pnpm install
```

你的 Node 24 / pnpm 环境可以直接运行。

## 2. 配置

复制：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`。

最低要求：

```env
WORKBUDDY_ACCESS_TOKEN=你的token
```

推荐配置共享密钥：

```env
RELAY_SHARED_SECRET=你自己生成的一段较长随机字符串
```

如果你还配置：

```env
WORKBUDDY_REFRESH_TOKEN=
WORKBUDDY_CLIENT_ID=
WORKBUDDY_CLIENT_SECRET=
```

遇到 401 时 Relay 会尝试按官方刷新接口更新 access token，并将运行期 token 写到：

```text
data\tokens.json
```

这个文件已加入 `.gitignore`。

## 3. Chrome 扩展

本项目已经带配套 v0.2 扩展：

```text
extension\
```

Chrome：

```text
chrome://extensions/
```

- 开发者模式
- 加载已解压的扩展程序
- 选择：
  `D:\Workspace\zhixing-relay\extension`

### 非常重要：绑定唯一 ChatGPT 对话

打开你真正用于“知行”的 ChatGPT 对话。

点击扩展图标：

```text
使用当前 ChatGPT 标签页
```

之后扩展只监听和操作这一页。

如果 `.env` 配置了：

```env
RELAY_SHARED_SECRET=...
```

扩展弹窗中的“共享密钥”必须填写相同内容。

## 4. 启动

```powershell
pnpm start
```

正常会看到：

```text
ZHIXING RELAY v0.1.0
Bridge: ws://127.0.0.1:8787
GPT forward mode: tagged
Auto send WorkBuddy result to ChatGPT: true
WorkBuddy: ONLINE
Chrome extension: waiting for connection...
```

扩展连接后：

```text
[bridge] Chrome extension connected
```

## 5. 为什么默认 GPT_FORWARD_MODE=tagged

Relay 不应该把 GPT 每一句解释都自动交给 WorkBuddy。

只有 GPT 回复中出现：

```text
[ZHIXING_RELAY]
TYPE: TASK
TASK_ID: P7-S4R4
SOURCE: GPT

这里写真正要交给 WorkBuddy 的任务……
```

Relay 才发送。

普通解释：

```text
我认为这里应该先检查架构……
```

不会发送给 WorkBuddy。

这是防止两个 Agent 无限制互聊的第一道门。

## 6. WorkBuddy 做完后

Relay 会包装成：

```text
[ZHIXING_RELAY]
TYPE: RESULT
TASK_ID: P7-S4R4
SOURCE: WORKBUDDY
WORKBUDDY_MESSAGE_ID: msg-...

<WorkBuddy 原始结果>
```

然后自动发回绑定的 ChatGPT 对话。

扩展会把这条消息视为 Relay 自己注入的消息，不会误判为你的人工插话。

## 7. 人工中断

终端直接输入：

```text
p
```

暂停：

```text
r
```

继续：

```text
s
```

停止当前“Relay 轮次”。

注意：

`stop` 只能停止 **Relay 继续转发**。
如果 WorkBuddy 已经开始本地任务，当前 Local Assistant Open API 没有在这个 V0.1 中使用取消执行接口，因此 WorkBuddy 可能继续完成它自己的当前任务。

紧急退出：

```text
x
```

查看状态：

```text
status
```

手工测试 WorkBuddy：

```text
wb 只回复：ZHIXING_RELAY_TEST_OK
```

手工向 ChatGPT 输入框放文字（不自动发送）：

```text
gpt 这是 Relay 手工测试
```

## 8. 你人工在 ChatGPT 插话时

默认：

```env
PAUSE_ON_MANUAL_USER_MESSAGE=true
```

也就是说只要你亲自在绑定的 ChatGPT 对话里发送一条消息：

```text
先停一下，这里判断不对。
```

Relay 自动进入：

```text
PAUSED
```

你的指令拥有最高优先级。

处理完以后终端输入：

```text
r
```

再继续。

## 9. 审计和状态

```text
data\state.json
data\audit.jsonl
```

都只在本机保存。

`.gitignore` 已经排除运行状态和 token 文件。

## 10. 首次测试顺序

不要第一步就跑真实知行任务。

先：

```powershell
pnpm start
```

然后终端：

```text
wb 只回复：ZHIXING_RELAY_TEST_OK
```

确认 WorkBuddy 返回。

然后：

```text
gpt RELAY_TO_GPT_TEST
```

确认绑定 ChatGPT 的输入框出现文字。

最后才测试完整闭环。

## 11. 正式闭环测试用 GPT 指令

让 GPT 回复以下协议即可：

```text
[ZHIXING_RELAY]
TYPE: TASK
TASK_ID: RELAY-SMOKE-001
SOURCE: GPT

只检查当前知行仓库 git status，不修改任何文件。
返回当前分支、HEAD、working tree 是否 clean。
```

Relay 将自动把它发送给 WorkBuddy，收到结果后再回到 ChatGPT。

## 12. 开发门禁

```powershell
pnpm check
```

执行：

```text
TypeScript typecheck
+
Vitest
```

## 安全说明

- Relay 只监听 `127.0.0.1`。
- WorkBuddy Token 不进入 Chrome 扩展。
- Client Secret 不进入 Chrome 扩展。
- 默认不会自动批准 WorkBuddy 工具权限。
- Chrome 扩展必须绑定一个明确的 ChatGPT 标签页。
- 正式自动转发默认只认 `[ZHIXING_RELAY] TYPE: TASK`。



## Milestone

### v0.1.0-workbuddy-cdp

Completed:

- WorkBuddy Electron CDP connection
- Slate Editor input injection
- WorkBuddy send automation
- Task running state detection
- Completion detection

Known issues:

- Chrome Extension Bridge reconnect
- ChatGPT browser injection