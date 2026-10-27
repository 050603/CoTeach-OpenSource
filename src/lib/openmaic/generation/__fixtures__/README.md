# 合成容量与排版回归样例

本目录的五个 JSON 保留历史问题的结构条件，说明正文、示例与可见要点已重新编写为合成教学材料。它们不再被称为未经修改的真实模型响应。来源类型与结构标识只是模拟输入；资源仅提供三组占位尺寸，没有附带教材图像、数据地址或真实课程数据。

| 样例 | 必须保留的回归条件 |
| --- | --- |
| `source-flow-capacity.json` | 4 个原页面、13 个解释节点、3 个图形占位；完整六步流程和对应图不可拆开；锁定页面、全部文字与时长守恒；不可行时保留失败 |
| `scaffolding-capacity.json` | 3 个页面、9 个解释节点；长定义、5/6 步流程和完整口头案例；前置概念先讲、图关系与时长守恒 |
| `task-driven-capacity.json` | 4 个节点的概念、流程、条件、案例；107 秒预算；容量分页后完整定义须先于条件，不丢要点或虚构已讲前置 |
| `native-text-default-placement.json` | 3 个长定义与4项简短显示责任区分；默认可读布局、完整裸引用与原生元素保留 |
| `native-text-placement-conflict.json` | 同一完整箭头关系，保留多余连接线造成的负例及原有失败断言 |

容量输入的完整解释仍为数百字，包含区别、条件、反例、顺序与独立案例；不要缩短为标题、重复填充文字，或仅为让布局通过而删掉条件。使用真实 Chromium 字体测量的容量与原生排版测试核对可行布局、至少 22 px 正文字号、内容归属和全量保存。合成材料中的教育情境不代表实测教学效果，也不是权利已经确认的外部教材引用。

对应回归位于上一级的 `source-flow-capacity.test.ts`、`scaffolding-page-capacity.test.ts`、`prerequisite-page-capacity.test.ts`、`native-text-placement.test.ts` 与 `slide-display-contract.test.ts`；概念和来源一致性另见[蓝图样例](../../../course-design/__fixtures__/README.md)。仓库整体许可证由维护者另行确定。
