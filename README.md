# dsh-vpn-guard（DeepSeek Harness 插件）

在 **DeepSeek Harness** 里直接操作 v2rayN 订阅守护，不用再开独立的小助手窗口。

> 依赖 [v2rayN](https://github.com/2dust/v2rayN) 与本机配套的 `vpn_guard.py` 守护脚本（纯 Python 标准库）。
> 本插件不联网、不上传任何数据，只读本地 v2rayN 配置/日志并向 `127.0.0.1` 页面提供 JSON 接口。

## 功能

会话标题栏出现 **「VPN」** + 状态点（绿=守护运行且网络通、黄=守护未运行/权限提醒、红=网络不通）。
点开是一个浮层面板：

- 守护：运行中（PID）/ 未运行
- v2rayN：运行中 v1.0.x / 未运行 / ⚠ 管理员权限无法控制
  （版本和端口都是自动读的：v2rayN 1.0.18 是 10808，1.0.23 起是 30808）
- 当前节点、网络延迟、订阅更新时间、可用节点数、切换策略
- 按钮：**一键修复**（刷新订阅 + 换最优节点）、**启动守护**、**停止守护**、**刷新订阅**
- 「看日志」展开最近守护日志

## 它背后是什么

Host 半调用本机工具目录里的 `vpn_guard.py`：

| 动作 | 命令 |
| --- | --- |
| 状态 | `--json [--no-health]` |
| 启动/停止守护 | `--start` / `--stop` |
| 刷新订阅 | `--refresh-sub` |
| 换节点 | `--switch-best` |

## 配置

| 环境变量 | 作用 |
| --- | --- |
| `DSH_VPN_GUARD_DIR` | 工具目录（含 `vpn_guard.py`）；不设时依次探测：插件目录同级的 `v2rayN自动订阅更新`、`%USERPROFILE%\v2rayN自动订阅更新` |
| `DSH_VPN_GUARD_PYTHON` | 指定 python.exe；不设时自动探测 `%LOCALAPPDATA%\Programs\Python\Python3{14,13,12}\python.exe`，再退回 PATH 上的 `python` |

## 安装

要求：Windows、v2rayN、Python 3 与 `vpn_guard.py` 已就绪。

```text
dsh plugin --profile <profile> add file:<本目录绝对路径>
```

或用插件管理器「安装本地插件」选择本目录，然后重启 DeepSeek Harness。

## 面板挂载方式（DSH 0.2.x 注意）

面板注册在 `shell.overlay`（宿主全局浮层），而不是会话头部内部的 `position: fixed`：
DSH 0.2.x 的会话区祖先节点带 `overflow`/`transform`，挂在头部里的 fixed 面板会被裁掉（点开看不见）。
标题栏只保留一个轻量按钮，点击通过模块级 store 切换浮层面板。

## 更新日志

- **1.1.0**：面板改挂 `shell.overlay`，修复 DSH 0.2.x 下点开看不见的问题；
  工具目录与 Python 路径改为环境变量 + 自动探测，去掉硬编码的本机路径。
- 1.0.0：首个版本。

## 注意

- 守护不会开机自启；不点「启动守护」就不在后台跑。
- v2rayN 以管理员身份启动时，普通权限的 Harness 无法控制它，面板会提示。
- 换节点会让 v2rayN 重启一次（代理断 5~10 秒）。

## 许可

MIT
