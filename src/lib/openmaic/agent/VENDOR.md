# pi Agent 依赖与来源

课件编辑 Agent 通过 npm 依赖使用 pi 运行循环；本目录维护 CoTeach 的适配代码，没有复制整套 pi 源码。

## 当前依赖

- 上游：`github.com/earendil-works/pi`，作者 Mario Zechner，MIT 许可。
- `@earendil-works/pi-agent-core` 与 `@earendil-works/pi-ai` 在根 [package.json](../../../../package.json) 中固定为 `0.78.0`，安装解析由锁文件固定。
- [build-agent.ts](runtime/build-agent.ts) 使用 Agent 循环与工具调用钩子；历史消息、工具白名单和请求上下文由应用提供。
- [stream-fn.ts](runtime/stream-fn.ts) 经项目 `streamLLM` 调用已配置模型，并适配 pi 消息事件流，不直接使用 pi 的 Provider 实现。该文件包含本地事件流队列适配。

当前集成未使用 pi 的终端界面和 coding agent；功能范围见 [README.md](README.md)。不能从依赖包具备某项能力推断 CoTeach 已开放会话压缩、技能或其他工具。

## 升级维护

升级时同时核对两个包的版本、消息与工具协议、流式错误和结束事件，再运行应用中受影响的 Agent 回归。若未来确需复制或修改上游源码，应另行记录来源版本、修改范围与许可；尚未实施的复制计划不作为当前架构说明。

## MIT Attribution

```
Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
