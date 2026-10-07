# dsh-strata-console

一个 DeepSeek Harness 插件，用于运行本地的 **Strata** 模型服务器，并且
带有按钮。

Strata（`D:\strata`）是一个 GGUF 推理服务器：`engine\strata.exe` 加载
`D:\strata\Strata-Models\*.gguf` 并对外提供兼容 OpenAI 的 API。本 profile 已经把一个
LLM 提供方指向该 API，所以缺失的那一半是进程生命周期 —— 此前没有任何东西会启动
这个服务器。本插件补充的正是这一半。

## 使用方式

两个座位，一份数据层：

| 位置 | 说明 |
|---|---|
| **侧边栏底部**，紧挨 Cordis 面板按钮 | 一整行 —— 一个状态圆点加上 **Strata 控制面板** —— 在应用的任何位置都能以对话框形式弹出整个控制面板。在它下方，一个实时输出框跟随被监管进程自身的输出（40 行，每 4 秒轮询一次，在服务端截尾，因此每次轮询的数据量都很小）；它没有标题文字，因为上方的按钮已经点明了它的对象。折叠到 56px 栏宽时，该列只保留圆点。对话框主体在受视口约束的框架内滚动，因此再高的面板也不会把对话框挤出屏幕。 |
| **输入框工具行**（输入框左侧，紧挨权限与模型控件） | 一个状态圆点和一个按钮。**启动是一次点击；停止是按住三秒** —— 按钮就待在光标下方，而长篇回答正在流式输出，此时误点一下就会在作答中途把模型丢掉。按住期间它会倒计时（`松手取消 3s`），在按钮之外任意位置松手都会取消。面板自身的 停止 仍然只需单击，因为在对话框里按下它属于有意操作。圆点在就绪时为绿色，启动中为琥珀色，已停止为灰色，异常退出后为红色。悬停可查看完整状态行。 |
| **设置 → 插件 → dsh-strata-console** | 同一个完整面板的内嵌版本：状态、启动 / 停止 / 重启 / 强制停止、带约定检查的 Strata 目录、监听端口、所服务的模型与上下文窗口、进程信息，以及进程日志或引擎日志。 |

弹出窗口与设置页渲染的是同一个组件（`StrataBody`），因此两者
永远不会出现偏差。每个座位在可见状态下每三秒轮询一次宿主，所以一次需要一分钟的启动会
报告进度而不是一直挂起：
`启动` 立即返回，而当 `/health` 应答时圆点变绿。每个
请求也都带有自己的截止时间，因为一个永不结算的连接
否则会让面板的控件卡在 `loading` 状态而一直禁用。一次操作会在面板中报告它做了什么 —— 一次只说
“未做处理”的停止，读起来与一个失效的按钮完全一样。

### 选择 Strata 目录

面板的 **Strata 目录** 区段掌管 Strata 所在的位置（设置页和
侧边栏弹窗都会显示它）：

- **选择目录…** 打开操作系统的文件夹选择器（通过桌面外壳，或在
  普通浏览器中使用工作区选择器），按下面的约定检查所选目录，
  并且 —— 当你选中的是该 checkout 的*父目录*时 —— 会跟随它所发现的嵌套
  目录，并把它作为一个一键修复方案提供出来。
- 它旁边的文本字段可直接输入路径，用于 UNC 路径或不常见的
  布局。按 Enter 或 **应用** 即可应用。
- 该选择会写入本 profile 的 `cordis.patch.yml`，并通过
  Loader 应用，因此它会立即生效 —— 无需重启，也无需手工
  编辑任何东西。

缺少必需约定条目的目录会被拒绝，并且报告会
明确指出缺了什么，因此一次选错永远不会让插件指向
空处。

### 选择监听端口

**监听端口** 行用于把服务器从 8080 移开：

- 数字字段加上 **改端口** 会把新端口写入 profile 并
  实时应用。该端口必须是空闲的 —— 插件会先探测它，并拒绝
  一个已被其他东西占用的端口。
- **同时更新指向该端口的模型提供方**（默认开启）还会重写每一个
  `baseURL` 在旧端口上拨号本机的 LLM
  提供方。若没有它，移动服务器会悄然破坏本 profile 所指向的
  模型；字段下方的行会列出涉及的具体提供方行
  （`llm-pi-ai · qwen-flash-next → http://127.0.0.1:8080/v1`）。
- 在 Strata 运行时整行都会被禁用，因为一个监管者无法追随
  一个它没有重启过的服务器去换新端口：正在运行的进程会继续占用
  旧端口，而插件会失去对它的追踪。请先停止、再改端口、
  然后重新启动。

### 其余每一个参数

在 端口 之下，面板编辑启动配置的其余部分，并一次性写入
整组参数：

| 参数 | 默认值 | 含义 |
|---|---|---|
| Python 解释器 | `""` → `<root>\.venv\Scripts\python.exe` | 运行 `serve/server.py` 的解释器 |
| 运行配置 | `""` → `<root>\strata-q2_0.json` | 由 `setup.py` 写入的运行配置 |
| 监听地址 | `127.0.0.1` | 绑定地址；`0.0.0.0` 也会服务局域网（含一键按钮） |
| 附加参数 | `[]` | 额外 argv，每行一个，例如 `--lazy`、`--api-key xxx` |
| 安装参数 | `[]` | 额外的 `setup.py` 标志，每行一个；由 首次安装 表单填入 |
| 更新参数 | `[]` | 手动更新时附加到 `setup.py --update` 后面的标志，每行一个 |
| 就绪等待（秒） | `300` | `strata_start` *工具* 等待 `/health` 的时长 |
| 闲置卸载（秒） | `0` | `>0` 时传递 `--idle-unload SECONDS`，在闲置时释放显存 |
| DSH 退出时停止服务 | **开启** | 在 DeepSeek Harness 退出时停止服务器，把显存交还 |
| 就绪后切换默认模型 | **开启** | 一旦 Strata 报告就绪，就把 DSH 的默认推理模型指向它 |

宿主强制执行两条规则：

- **被拒绝的字段不会改变任何东西。** 绝对路径字段必须指向一个
  存在的文件，`host` 必须是裸地址（不是 URL），数字必须落在
  范围内 —— 每个错误都会回传并钉在它自己的字段上，而未受影响的字段
  保持原值。
- **只在启动时生效的参数在 Strata 运行期间会被锁定**
  （`python`、`config`、`host`、`extraArgs`、`idleUnloadSeconds`）。在服务器运行中改动其中一项
  会让插件正在追踪的进程变成孤儿，因为
  替换后的插件实例启动时没有子进程句柄。`就绪等待` 和
  `DSH 退出时停止服务` 属于插件行为，因此它们保持可编辑。

**填入默认值** 会把默认值载入表单以供查看；在按下 **保存参数** 之前
不会写入任何内容。

字段列表本身位于 `lib/settings.js`，而 `GET /strata/api/settings`
会返回它，因此面板是*依据宿主自己的描述*来渲染表单的 ——
在那里新增一个参数就会把它加入 UI，无需第二处编辑。

### 让 Strata 成为默认推理模型

一旦某次启动到达 `/health`，插件就会把 DSH 的 **默认模型** 指向
Strata，这样新会话无需任何人打开
模型选择器就能与本地引擎对话。**模型与上下文** 区段会显示当前默认值、它是否是
Strata，并提供回退的办法。

它通过掌管该选择的那个服务来完成这件事 ——
`ctx.get('agentDefaultModel').saveSelection({ provider, model })` —— 并且 **绝不通过
向列表添加模型的方式**。它所指定的提供方和模型读取自
profile 自身的 LLM 行：即在所配置端口上拨号的那一行，其模型 id
来自运行配置所报告的内容。如果没有行在该端口上拨号，面板会如实说明，而不是
凭空发明一个。

两个值得了解的细节：

- `reasoningEffort` 不会被一并写入。该选择服务只报告提供方
  和模型，而本地模型没有这样的旋钮，因此该字段被省略
  而不是写入 —— 传一个显式的 `null` 会存入*字符串* `"null"`
  （profile 写入器会给它加引号），而引擎会把它当作一个 reasoning
  effort 接收。
- **该切换会等待就绪。** 面板的按钮在进程
  被派生出后立即返回，而 `running` 会一直为 false，直到 `/health` 应答，因此
  插件会轮询状态（每 3 秒一次，最多 15 分钟），并在
  权重真正加载完成后切换。若某次启动先退出了，则不会为它等待。

在 其他参数 中用 **就绪后切换默认模型** 关闭它；该区段的按钮仍然可以
手动切换。当 Strata 停止时不会自动回退任何东西 —— 面板
会改为发出警告（“默认模型指向 Strata，但它现在没在运行”），因为一个指向
已停止引擎的默认值会让每个新会话都失败。

### 更改模型与上下文窗口

模型和所服务的上下文 **不是** 插件设置 —— 它们存在于
`setup.py` 写入、且在启动时传给引擎的运行配置 JSON 中。它的
`args` 携带 `--max-context N` 以及模型文件（`--native`、`--ple-gguf`、
`--pack`、分词器），而 `model_name` 是服务器所报告的 id。
因此 **模型与上下文** 区段编辑的是那个文件：

- 它会显示当前哪个配置处于激活状态、它的模型 id、它的上下文窗口，以及
  它所指向的权重文件（悬停某一行可查看完整路径）。
- **上下文** 和 **模型 id** 可编辑。写入时会把原文件备份到
  它旁边的 `<name>.bak-<timestamp>`，再把替换文件重命名到位，因此
  引擎永远不会读到写了一半的配置。缺少
  `--max-context` 标志的配置会被补上该标志，而不是悄然忽略这次更改。
- **模型目录** 和 **数据目录** 用于迁移 `setup.py --gguf-dir` /
  `--data-dir` 所确立的两个根目录。迁移其中一个会重写该配置在其下携带的每一个
  路径 —— `--native`、`--ple-gguf`、`--pack`、`--mtp`、`tokenizer`，以及
  vision 条目 —— 并保持每个文件的相对位置，而且除非
  每个被重写的路径都存在，否则写入会被拒绝，因此选错文件夹会在
  引擎花上几分钟加载失败之前就被抓住。前缀比较不区分大小写，也
  不区分分隔符，并且被重写的路径会保留文件自身的分隔符
  风格，因此粘贴 `D:/…` 不会产生混合路径。
- **同时同步模型提供方的 id 与上下文** 会重写在该端口上拨号的
  DSH LLM 提供方，理由与端口控制重写其 `baseURL` 相同：一个
  仍提供旧模型 id 和旧 `contextWindow` 的
  提供方，描述的是一个服务器已不再报告的模型。
- 两者在 Strata 运行时都会被锁定，因为引擎在
  启动时只读取一次它的配置。
- 当该 checkout 中存放了不止一个配置时，每个都会作为一个按钮提供，用于
  切换插件的 `config` 设置 —— 这才是你切换到不同权重集的
  方式，而不是就地编辑。为一个*新的* GGUF 生成配置是
  `setup.py` 的职责（`START-HERE.bat` 加 `--gguf-dir` / `--data-dir`），并且它会
  从头重写该文件，因此之后再运行 `setup.py` 会丢弃这些编辑。

### 首次运行安装

一个还没有 `.venv`、没有运行配置或还没有模型文件的 checkout，可以从
面板进行设置，而不必使用 `START-HERE.bat`。**首次安装** 区段会显示
检查清单（Python / 虚拟环境 / 运行配置 / 模型文件）、这两个目录、确切的
命令，以及安装过程的实时控制台。

它运行的是随附启动器所运行的内容：

```
python -m venv .venv
.venv\Scripts\python.exe setup.py --gguf-dir <模型目录> --data-dir <数据目录> --yes --no-start
```

两个标志承载了从插件中做这件事的全部意义：

- **`--yes`** 接受推荐答案。`setup.py` 会提问，而一个
  没有终端的进程会死在 `EOFError` 上（“input ended before a setup
  answer was received”）；面板不是终端。
- **`--no-start`** 只安装而不启动模型。插件保持对服务器的
  所有权，而不是接手一个 `setup.py` 在其背后启动的
  实例。

#### 在面板中被问到的那些问题

`START-HERE.bat` 会问要哪个模型、哪个尺寸、多少上下文、哪种 KV 模式、
是否需要图像、哪块 GPU 等等。面板问的是同样的内容 ——
**模型家族 / 模型尺寸 / 上下文长度 / RoPE 扩展 / KV 缓存 / 图像输入 / 图像 token 上限 /
GPU / 低内存模式 / 并行请求数 / 保留显存 / 监听地址 / API 密钥** —— 而答案会成为
安装器命令行上的标志。

这些列表是 **从已安装的 `setup.py` 中读取的**，绝不从它复制：一次
探测会为 `FAMILIES`、`MODELS` 和 `CONTEXTS` 导入该模块，并从
参数解析器自身的帮助文本中读取那些枚举型标志（`--kv {int8,q4_0,k8v4}`）。
一次新增了某个尺寸或某种 KV 模式的 Strata 更新会自行出现在面板中；
只有标志的*选择方式*是我们自己的。GPU 列表来自 `nvidia-smi`，而
总 RAM 会与每个尺寸的要求作比较，正如 `setup.py`
所做的那样。当探测无法运行时，面板会说明这一点并回退到一份内置
列表。

每一个保留在 **推荐（默认）** 的答案都不会被传递，因此由 `--yes` 来回答它 ——
并且因为 `setup.py` 在提问之前会先读取显式标志（`if a.context: ctx =
a.context else: <ask>`），所以已选定的答案总是胜过推荐值。

**最终参数** 是组装好的命令行片段，每行一个 token。它
是可编辑的：在那里输入的任何内容都会被保留，并且它就是插件作为
`installArgs` 设置所存储的内容，因此安装会从插件配置中读取它的参数，
而不是从某个表单的记忆中读取。按下 **开始安装** 会先保存它，然后带着它运行
`setup.py` —— 一次点击，一个唯一事实来源。这同时也是逃生
出口：本表单没有问到的某个选项（或更新的 `setup.py` 新增的某个选项）
可以直接输入。

venv 步骤只在 `.venv` 缺失时才会运行，而解释器搜索
与启动器一致：`py -3.13` … `py -3`，然后是 PATH 上的 `python`，再然后是
`%LOCALAPPDATA%\Programs\Python` 下的每用户安装。当什么都找不到时，
该区段会说明这一点并提供唯一一个按钮，`winget install -e --id Python.Python.3.12
--scope user --silent` —— 也就是启动器自己的第一回退方案，且仅因为
用户要求它才会运行。（它的第二回退方案 —— 从 python.org 下载 `python-3.12.10-amd64.exe`
并静默运行 —— 被有意地*不*自动化：
README 改为把 URL 告诉你。）

这两个目录默认取运行配置已记录的内容，而在还没有运行配置之前，
则取启动器所假设的布局（checkout 旁边的 `Strata-Models` 和 `Strata-data`）。
一次安装会运行很多分钟 —— 最坏情况下有几十 GB —— 因此它
是一个后台子进程，其输出像服务器的一样被收集，而 **停止安装** 会终止它。
无论成功与否，进度在它结束后都可读取。

### 更新：引擎与代码

**更新** 按钮位于面板顶部的动作行末尾（启动 / 停止 / … 那一行），引擎版本就在它下面一行：

```
[启动] [停止] [重启] [强制停止] [刷新] [更新] [检查最新版本]
当前引擎 0.1.40.2   本版本要求 ≥ 0.1.40.2   远端最新 v0.1.40.2   已是最新，无需更新
```

**刷新** 排在前面，因为它只读模型服务器的状态，属于运行控制那一组；两个引擎动作排在
行末，紧贴它们所报告的版本行。

- **等待只在一处说出来，也只挡住一处。** 「检查最新版本」是一次只读的远端查询：除了
  **更新**按钮读作 `处理中…`，其它按钮都不变灰、文字也不变 —— 运行控制、目录行、安装与
  手动更新照常可用。一个只是变灰的「已是最新」看起来像没被点击，而一次远端查询恰恰是最
  需要让人知道它还在跑的那种等待；到处喊「处理中」反而看不出谁在做事。真正会改磁盘的操作
  （安装、更新、停止）照旧互相排斥 —— 那是安全要求，不是装饰。
- **更新** 先拉取最新代码（仅当该 checkout 是 git 克隆时，用 `git pull
  --ff-only`），然后运行 `setup.py --update` —— 也就是 `START-HERE.bat` 在启动
  之前所做的一切：安装固定版本的依赖包、在本版本需要时换上新引擎、并升级每个已
  安装模型的配置与草稿子集。它**不碰模型文件、也不启动模型**。
- **两个版本相同就不更新。** 这里遵循 `setup.py` 自己的规则 —— 它只在
  `engine_version < MIN_ENGINE` 时才替换引擎（否则 `elif ver >= MIN_ENGINE: return`，
  保留它自带的那一颗）。所以当前引擎 ≥ 本版本要求时，更新按钮会变成**灰的
  「已是最新」**并说明原因，不会被点成一次无意义的重下载；要强制刷新依赖与配置，
  用下面的「按参数更新」。
- **当前引擎版本** 由 `setup.py` 自己的 `engine_version()` 读出（先读二进制旁边的
  `BUILD.json`，否则读编译进二进制的版本），**本版本要求** 是它的 `MIN_ENGINE`。
- **检查最新版本** 会去查仓库发布页（`PREBUILT_URL` 里的 owner/repo，因此 fork 查
  的是 fork 自己）的 releases API，把 tag（`v0.1.40.2`）显示成"远端最新"。
  它只作**报告**用：远端更新但本版本不要求换引擎时，按钮依旧不可用 —— 那正是上游
  的行为（旧 checkout 保留它自带的引擎）。
- **检查结果只更新上面那一行**，不弹单独的提示：那一行就在按钮下面，正是版本信息的
  唯一去处；再弹一条横幅等于把同一句话写两遍，而且离按钮很远。查不到时（网络不通、
  `PREBUILT_URL` 不是 GitHub 发布页），那一行显示"远端查询失败"加上原因，鼠标悬停在
  "远端最新"上可看完整说明 —— 它不会假装"已是最新"。
- 拉取失败会**让流程停下并显示原因**，而不是继续 —— 否则代码还是旧的却报告"已更新"，
  启动器同样会在那里停下。
- **运行中的模型会被拒绝更新**（`更新要求模型没在运行…先停止`），因为上游会把正在
  使用的引擎保留到下次 —— 在更新前就拦住，比跑到一半才失败要清楚。
- **手动更新** 就在同一个区段里（首次运行安装的下半部分）：**手动更新参数** 是追加到
  `setup.py --update` 之后的参数（一行一个，例如 `--build`、`--cuda 13`），
  **按参数更新** 则只跑这条命令、**不拉取代码** —— 这正是 git 无法更新的 checkout
  （或拉取失败时）该走的路。
- 当 checkout 不是 git 克隆时，面板会说明这一点，并给出启动器自己的回退方案：下载
  `main.zip`、解压到任意位置、运行里面的 `START-HERE.bat` —— 它会找到
  `Strata-data` 里的模型文件，不会重新下载大文件。

### 目录约定

| 条目 | checkout 内的路径 | |
|---|---|---|
| 服务脚本 | `serve/server.py` | **必需** —— 插件所启动的服务器 |
| 私有解释器 | `.venv/Scripts/python.exe`（Windows）/ `.venv/bin/python` | 预期 —— 回退到 `python` 设置，再回退到 `PATH` |
| 运行配置 | `strata-q2_0.json` | 预期 —— 由 `setup.py` 写入的运行配置 |
| 推理引擎 | `engine/strata.exe` | 预期 —— 加载 GGUF 权重的可执行文件 |
| 数据目录 | `data/` | 预期 —— 引擎的辅助数据 |

只有 `serve/server.py` 是硬性要求；其余只作警告，因为一个 checkout
可能使用不同的解释器、命名不同的运行配置，或者根本没有 venv ——
`python` 和 `config` 设置正是为这些情况而存在的。该检查
不依赖框架（`lib/layout.js`），因此它也可以独立运行：

```powershell
node scripts\selfcheck.mjs layout --root D:\strata\Strata-main
```

面向模型的工具仍然保留，用于该由智能体来做的时候：

| 工具 | 作用 |
|---|---|
| `strata_start` | 派生服务器并等待 `/health` |
| `strata_stop` | 终止本插件启动的服务器（`force` 也会杀掉一个不是它启动的实例） |
| `strata_status` | 就绪状态、模型 id、上下文窗口、加载状态、运行时长、上次退出 |
| `strata_logs` | 捕获的进程输出，或引擎日志文件的尾部 |

## 布局

```
package.json                    该 bundle：dsh.bundle.patch、dsh.client、manifestVersion
cordis.patch.yml                该 bundle 补丁 —— 挂载插件的唯一一行
lib/host.js                     宿主半边：配置、四个工具、路由接线
lib/http-api.js                 宿主半边：按钮所调用的 /strata/api 路由
lib/layout.js                   Strata 目录约定及其检查
lib/settings.js                 可调参数、它们的校验以及面板的表单描述
lib/runconfig.js                引擎自己的运行配置：读取，并就地编辑模型 id / 上下文
lib/setup.js                    首次运行安装：查找 Python、创建 .venv、运行 setup.py --yes --no-start
lib/setup-options.js            安装问题，及其从已安装 setup.py 中解析出的列表
lib/client.js                   浏览器半边：按钮和面板（CommonJS 工厂，无需构建）
lib/process/supervisor.js       StrataSupervisor —— 不依赖框架的进程生命周期
scripts/selfcheck.mjs           在纯 Node 下运行监管器与布局检查
```

## 它启动什么

与 `run-q2_0.bat` 启动的完全相同，只是用 venv 解释器：

```
D:\strata\Strata-main\.venv\Scripts\python.exe  D:\strata\Strata-main\serve\server.py
    --engine strata  --config D:\strata\Strata-main\strata-q2_0.json  --port 8080  --host 127.0.0.1
```

就绪判据是服务器自己的 `GET /health`，它在监听器就绪后应答
`{"status":"ok"}`；它的 `loaded` 字段说明权重是否已
驻留内存。在本机上，一次热启动大约十秒即可达到就绪。

## 浏览器 API

这些按钮是四条路由之上的一个视图，任何同源客户端都可以调用：

```
GET  /strata/api/state                         状态快照
GET  /strata/api/layout[?root=]                目录约定报告
POST /strata/api/config {root}                 检查、持久化并实时应用一个目录
GET  /strata/api/provider                      指向本端口的 LLM 提供方
POST /strata/api/port {port, updateProviders}  检查、持久化并实时应用一个端口
GET  /strata/api/settings                      可调参数、它们的边界与默认值
POST /strata/api/settings {values}             校验、持久化并实时应用每一个参数
GET  /strata/api/runconfig                     当前激活的运行配置以及每一个候选
POST /strata/api/runconfig {maxContext, modelName, modelsRoot, dataRoot, syncProvider}
                                               编辑引擎自己的配置文件
GET  /strata/api/model                         默认推理模型，以及 Strata 将会设置成的值
POST /strata/api/model [{provider, model, reasoningEffort}]
                                               把默认模型指向 Strata，或指回去
GET  /strata/api/setup                         首次运行检查清单与安装进度
POST /strata/api/setup {action, modelsDir, dataDir, pull}
                                               install | update | check-latest | install-python | stop
GET  /strata/api/logs?source=process|engine|setup&lines=N
POST /strata/api/action {action, force?}       start | stop | restart
GET  /strata/api/diagnostics                   本插件是如何被挂载的
```

`action` 应答的快照与 `state` 返回的相同；`start` 从不等待
模型加载，这正是让按钮保持响应的原因。`config` 会拒绝一个
缺少必需约定条目的目录，并无论哪种情况都返回该报告；
`port` 会拒绝一个已被占用的端口，并且在有服务器运行时直接拒绝；
`settings` 对一次拒绝的应答是每个不合格字段一条记录。

这些路由施加与 `/api` 网关相同的跨站防护：`Host`
必须指明本机（回环地址或已配置的可信主机），`Sec-Fetch-Site`
不得为 `cross-site`，并且附带的 `Origin` 必须与请求的
主机名匹配。那是针对 DNS 重绑定与跨站的防御，不是身份验证 ——
DSH 在索引响应上设置的签名会话 cookie 才是身份验证。

## 配置

插件的 `config` 块接受：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `D:\strata\Strata-main` | Strata checkout —— 仅为默认值；面板的 选择目录… 会把真正的选择写到这里 |
| `python` | `""` → `<root>\.venv\Scripts\python.exe` | 运行 `serve/server.py` 的解释器 |
| `config` | `""` → `<root>\strata-q2_0.json` | 由 `setup.py` 写入的运行配置 |
| `port` | `8080` | 要绑定的端口 —— 仅为默认值；面板的 改端口 会写入真正的选择，而 DSH 的 LLM 提供方必须指向它 |
| `host` | `127.0.0.1` | 绑定地址；`0.0.0.0` 也会服务其他设备 |
| `extraArgs` | `[]` | 额外 argv，例如 `["--api-key", "…"]` |
| `readyTimeoutSeconds` | `300` | `strata_start`（该工具）等待 `/health` 的时长 |
| `idleUnloadSeconds` | `0` | `>0` 时传递 `--idle-unload SECONDS`，在闲置时交还显存 |
| `stopOnExit` | `true` | 在 DeepSeek Harness 退出时停止服务器 |

`stopOnExit` 默认为 `true`：退出 DeepSeek Harness 会停止服务器并
交还显存，因此不会有什么在用户已关闭的应用背后继续让约 40 GB 的
mmap 专家权重活着。代价是下次启动要重新加载。当模型应当比应用活得更久时
就关掉它 —— 服务器届时会继续存活，而下一次启动会接手它，
而不是再启动第二份副本。

它挂接的是 **进程自身的退出**，而不是插件的销毁，而这一
区别很重要：一次配置变更或一次 HMR 编辑会销毁并重新应用这个
fiber，因此在那里停止会在每次保存设置时杀掉一个正在工作的服务器。
退出时任何异步操作都无法结算，所以整棵进程树会被同步终止
（Windows 上为 `taskkill /T /F`）—— 而且只针对本插件派生出的进程，其
pid 取自句柄，或者当某次启动在报告 pid 之前就返回了时，取自
正在所配置端口上监听的那个套接字。

插件的 `stop()` 是显式 停止 所运行的代码，它会终止整棵进程树
（Windows 上为 `taskkill /T /F`），因此即使 harness 自身的关停预算比一次
优雅停止更短，引擎进程也不会比监管器活得更久。

## 在 profile 中安装它

该包是一个 **bundle**：它在 `package.json` 中声明 `dsh.bundle.patch`，而
profile 在 `dsh.profile.bundles` 中选择它。正是这一点让插件
页面把它列为一个真正的插件，而不是一个普通依赖 —— 一个没有
bundle 补丁的包不是插件，而 profile 只有在它被选中时才会带一个例外标记
把它列出来。

`dsh-strata-console\cordis.patch.yml` —— 该 bundle 声明了它的唯一一行，其中没有任何
机器专属的值：

```yaml
- insert:
    - id: strata-server
      name: ./lib/host.js
```

该名称是相对于补丁的，因此加载器会把它锚定在该文件旁边，并把它变成
一个 file URL；该 bundle 在任何 checkout 位置都能工作。

`$DSH_HOME\profiles\desktop\package.json` 选择该 bundle：

```json
"dependencies": { "dsh-strata-console": "link:./plugins/dsh-strata-console" },
"dsh": { "profile": { "bundles": ["…", "dsh-strata-console"] } }
```

`plugins\dsh-strata-console` 和 `node_modules\dsh-strata-console` 是指向本
checkout 的 junction，这正是 `link:` 的解析方式。

随后 `$DSH_HOME\profiles\desktop\cordis.patch.yml` 会调整该行 —— profile
补丁在每一层 bundle 之后应用，而一个补丁会替换该行的整个
配置：

```yaml
# 监视插件自身的源码，让编辑热重载，而不必等待重启。
- id: hmr
  config:
    root:
      - D:/Desktop/222/dsh-strata-console

- id: strata-server
  config:
    root: D:\strata\Strata-main
    port: 8080
    host: 127.0.0.1
    readyTimeoutSeconds: 300
    stopOnExit: true
```

### 编辑插件

上面的 `hmr` 行会监视这个目录，因此保存 `lib/host.js` 或
`lib/process/supervisor.js` 会在一两秒内重载运行中应用里的 **宿主** 半边 ——
无需重启。**浏览器** 半边则不同：页面从注入索引文档的一个清单中
获取它的插件 bundle，因此对 `lib/client.js` 的更改 —— 或者首次
添加客户端半边 —— 需要刷新一次页面（F5）。之后对 `lib/client.js` 的编辑
会通过客户端 HMR 修订推送，无需刷新。

Bundle 层面的更改 —— `package.json`、`cordis.patch.yml`，或 profile 的
`bundles` 列表 —— 在 profile 协调时被读取。它们也会实时生效，但如果
某项更改没有生效，请重启 DeepSeek Harness。

## 不依赖 DSH 进行验证

`scripts/selfcheck.mjs` 通过一个基于 `node:child_process` 的适配器，
提供了监管器所需的唯一一项宿主能力 —— 一个形如
`ctx.subprocess.spawn` 的函数：

```powershell
node scripts\selfcheck.mjs status   # 仅探测，不启动任何东西
node scripts\selfcheck.mjs layout   # 打印目录约定报告
node scripts\selfcheck.mjs setup    # 打印首次运行检查清单，不安装任何东西
node scripts\selfcheck.mjs cycle    # 启动、等待 /health、打印日志、停止
node scripts\selfcheck.mjs logs --source engine --lines 20
```

请先关闭 DeepSeek Harness：两个监管器争夺同一个端口，正是
接手规则所要防止的情况。

## 设计说明

- **三个座位，一个主体。** 浏览器半边注册到
  `sidebar.footer.action`（弹窗）、`conversation.input.left`（输入框
  控件）以及 `plugins.bundle.config`（该 bundle 的页面）。底部操作是一个
  `list` 槽位，它只接收列状态（`wide`），这正是让
  该列能在 56px 栏中折叠成一个圆点的原因。该槽位所有者把它的操作排布在
  一个 `display: flex; width: 100%` 行中，因此该座位渲染出一个全宽的
  **列** —— 按钮，然后是进程输出 —— 并且是在该列上而非按钮上
  请求 `flex: 1 1 auto`，因为在列布局中那会让它在垂直轴上被拉伸。
  弹窗是这些原语的 `Modal` —— 它是一个 380px 的确认卡片，因此客户端半边注入一份
  样式表（模块系统所期望的那种模式），把它*自己的*对话框加宽到
  640px，并让可滚动主体在 flex 列内收缩。这样路径字段
  就会占满整个卡片宽度，而不是被它们的标签挤压（同时
  重置它们的 flex 尺寸，因为基础输入样式的 `flex: 1 1 260px` 否则
  会变成列布局中的 260px *高度*）。
- **目录、端口以及每一个参数都是数据，不是代码。** 目录约定
  位于 `lib/layout.js`，参数列表位于
  `lib/settings.js`，取值位于 profile 补丁中，而 `ctx.configEditor`
  掌管写入：它编辑 `cordis.patch.yml` 中的目标行，并通过
  Loader 协调，因此一次更改会实时生效，并且无需任何人编辑 YAML 就能
  在重启后依然有效。插件从不自己写 profile 文件，而且它
  只在端口更改明确要求时才触碰另一个插件的行。
  面板的表单由宿主的字段描述生成，因此 UI 与
  校验不可能列出不同的参数。
- **两个文件，两个所有者。** 插件自身的设置经过
  `ctx.configEditor` 进入 profile 补丁；模型与上下文窗口
  属于 Strata 的运行配置，因此 `lib/runconfig.js` 直接编辑那个文件 ——
  带时间戳备份、同目录重命名，并且只改它
  能够安全更改的那两个键。面板从不发明运行配置：把引擎指向
  不同权重始终是 `setup.py` 的职责。
- **路由是等 web 服务器，而不是假设它在。** `ctx.get` 只会返回提供者
  fiber 已经激活的服务，所以一次裸查询会**静默跳过**整段路由注册 —— 而四个
  工具仍然正常注册，因此一切看起来都没问题，直到面板回 404。路由因此挂在
  `ctx.inject(['webServer'], …)` 里：它会启动一个等待该服务的嵌套插件体，
  并且在没有任何 web 服务器的组合（无头、SDK、ACP）里那段代码根本不会运行，
  而不是抛错。
- **默认模型是被选中的，不是被声明的。** 选择模型正是
  `agentDefaultModel` 存在的意义，因此插件对它调用 `saveSelection`，并
  让每一行 LLM 都保持原样。它丝毫不向选择器所显示的
  列表中添加模型 —— 那个列表属于 profile，且只属于 profile。
- **每个端口只有一个所有者。** `server.py` 会拒绝忙碌的端口，因此一次启动会先探测
  `/health` 并接手一个不是它派生的监听者。`停止` 会停止任何
  服务所配置端口的实例 —— 包括*先前*某次插件运行所启动的实例，
  它会被报告为已接手 —— 而 `强制停止` 会跳过子进程句柄，
  直接终止端口所有者。这一区别并非表面文章：一次配置
  变更或一次 HMR 编辑会重新应用插件，而替换后的实例没有
  子进程句柄，因此一次所有权测试会让主按钮什么也不做。
  只有真正持有该端口的进程才会被触碰。
- **宿主半边没有依赖、没有裸导入。** 进程接缝是
  `ctx.subprocess`，因此子进程是一个受管进程，宿主在自身销毁时会
  终止它，而输出通过宿主的基于偏移的收集器读取（一个
  有界的内存尾部加上一个保存完整流的溢出文件）。唯一的
  导入是相对路径的 `./process/supervisor.js` 和 `./http-api.js`。这一点
  很重要，因为 DSH 会为 profiles 树之下以及*被链接的* profile 根之下的
  路径安装它按模块的解析拦截层，而一个由实时 profile 补丁更改所挂载的插件
  会在一个新创建的链接根拥有该层之前就被导入 —— 因此来自一个刚被链接的
  插件的裸 `@deepseek-ai/*` 导入会以 `ERR_MODULE_NOT_FOUND` 失败，而该条目会
  静默地处于未激活状态，没有任何可见原因。代价是 `defineTool` 和一个 schemastery 的 `Config`
  不可用，因此宿主半边注册的是原始 `ToolDefinition`，带 JSON-Schema
  参数，并自行规范化它的配置。
- **浏览器半边无需构建步骤。** DSH 把客户端半边作为
  注册在 `window.__ModuleLoader__.load` 上的 CommonJS 风格工厂来提供，
  其中 `require` 解析平台种子表（`react`、`react-dom`、
  `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、
  `@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、
  `@deepseek-ai/dsh-client-ui-dockkit`）。手写实现，它不需要打包器、不需要
  JSX，也不需要 `dsh.client.external` 条目。
- **无损的工具取值。** 工具结果必须是无损 JSON，而一个
  `undefined` 属性不是 —— 它会在 `JSON.stringify` 下消失。该
  监管器返回诚实的 JavaScript（缺失字段为 `undefined`），而
  `prune` 会在工具边界再次被应用，那才是面向模型的契约
  真正所在之处。
- **超出预算的启动不是失败。** `strata_start` 会返回
  `running: true, ready: false` 以及原因和捕获的尾部；请调用
  `strata_status` —— 或者只是看着圆点 —— 来继续轮询。只有当
  进程在启动期间真的退出了它才会抛错，而那时它会包含输出的
  最后几行。

## 已知限制

- 已挂载的 file URL 不能携带查询字符串：`…/host.js?v=2` 会不通过
  加载器的解析，而该条目会一直处于未激活状态。请改用 `hmr` 监视根（或
  一次重启）来接收代码更改。
- Node 会在进程的整个生命周期内按解析后的 URL 缓存 ES 模块，而
  插件的包元数据会按加载器说明符缓存，直到重启。因此，
  新增或重命名该行的模块文件，是同时强制一次全新
  导入和一次全新元数据扫描的办法 —— 这也是为什么该行按路径而不是按包名
  挂载 `lib/host.js`。
- 只有端口的所有者会被解析出来用于 `强制停止`；一个绑定到与所配置端口不同的
  端口的服务器会被报告为“already stopped”。
