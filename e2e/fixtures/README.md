# 浏览器回归素材

`prelaunch-video.webm` 由仓库的 [生成脚本](../../scripts/generate-playback-fixture.mjs)从零绘制几何图形并合成 330 Hz 音调，约 3 秒、320×180、VP8/Opus。没有使用摄影、录音、教材、人物或第三方图像；它只用于检验视频解码、播放和自动播放失败后的重试。

```bash
node scripts/generate-playback-fixture.mjs
```

命令使用已安装的 Playwright Chromium。录制时间戳和编码字节可能随浏览器版本变化，内容与测试用途保持一致。脚本写入前使用浏览器检查可解码、播放时间前进、至少 20 帧并触发结束事件；变更播放器逻辑时另运行对应播放器回归；不要替换为实际课堂录像。

同目录 TypeScript 夹具提供合成账号、课程和界面状态，不导出本机教学数据。正式品牌图仍由产品入口引用，其公开使用范围另见[品牌说明](../../docs/brand.md)及[第三方声明](../../THIRD_PARTY_NOTICES.md)。
