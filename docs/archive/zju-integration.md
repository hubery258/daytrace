# ZJU 集成设计与路线

## 1. 产品定位

日迹仍然是本地个人效率工具。ZJU 集成的目标不是把日迹做成脚本平台，而是把校园系统中已经存在的学习任务、课程安排、成绩与学分信息，转成日迹能理解、能回滚、能复盘的本地数据。

核心原则：

- 只读优先：默认只读取任务、课表、成绩、学分等信息，不向学校系统提交签到、答题、刷课、续借等写操作。
- 手动确认：导入前必须预览，用户确认后才写入日迹。
- 可撤销：导入产生的数据必须能按批次回滚。
- 本机优先：允许用户选择把 ZJU 密码和 Pintia Cookie 明文保存到本地 SQLite，以换取单机便利；必须提供不保存和清除入口。
- 不做脚本市场：不提供任意脚本选择、下载、部署或运行入口。

## 2. 已完成版本

### v0.1.1：ZJU 学习任务导入

范围：

- 学在浙大待办导入。
- Pintia 任务导入。
- 导入预览、去重、手动确认写入。
- 使用 `ExternalItem(source + external_id)` 避免重复创建。
- 使用 `ImportBatch` 记录导入批次，支持撤销最近一次任务导入。
- ZJU 凭据支持本地保存、临时使用和清除。

不包含：

- 自动签到。
- 刷课或自动完成学习记录。
- quiz/互动题答案获取。
- 课件批量下载。
- Webplus 文档归档。
- 图书续借。
- 自动定时同步。

### v0.1.2：ZJU 本科课表导入日迹计划日程

范围：

- 将 ZJU 集成从设置页拆到独立 ZJU 页面。
- 保留原有学习任务导入能力。
- 新增本科 ZDBK 课表预览、导入计划日程、撤销上次课表导入。
- 校历改为用户点击时手动拉取，成功后缓存到本地；课表预览只读取本地缓存。
- 学年改为下拉选择：从 `2022-2023` 到设备当前年份对应学年。
- 当 CDN 暂无未来学年校历时，返回友好的“暂时没有数据”提示。
- 日程页增加日期直跳，便于跳到导入课程所在日期。

课表导入映射到 `Schedule`：

- `name`：课程名。
- `start_time` / `end_time`：结合校历展开后的本地 naive datetime。
- `category`：`课程`。
- `nature`：`no_other_task`。
- `location`：教室或线上说明。
- `notes`：来源、外部 ID、教师、周次、节次等。
- `is_planned`：`true`。

关键修正：ZDBK 半学期映射

ZDBK 的 `xqm=3/12` 只表示查询秋冬/春夏大组合，但返回项仍需要读取 `xxq` 区分具体半学期：

- `秋/春` 属于上半学期，对应校历 `startEnd[0]..startEnd[1]`。
- `冬/夏` 属于下半学期，对应校历 `startEnd[2]..startEnd[3]`。

课表展开不能简单从 `startEnd[0]` 开始按周滚动，否则当接口返回混合项时，会把春夏课程投影到秋冬日期，造成导入后日期错误和课程重叠。

当前实现按 Celechron 的做法处理：

- 先用 `xxq` 过滤掉不属于当前选择大组合的课程。
- 再把缓存校历拆成上半学期和下半学期。
- 按半学期、单/双周、星期几生成实际日期。
- 再应用假期和调休映射。

如果用户已经用旧逻辑导入过错误日期的课表，应先在 ZJU 页面执行“撤销上次课表导入”，再重新预览和导入。

## 3. v0.1.3：成绩与学分概览，v0.1.x 收官版本

v0.1.3 将原计划放到 v0.2 的成绩与学分能力前移，作为 v0.1.x 的最后一个版本。完成后，项目进入 v0.2.0。

### 3.1 功能定位

成绩与学分功能放在 ZJU 集成页中，作为“学业概览”，只读展示，不进入日迹首页的待办/日程主流程。

应支持：

- 本科 ZDBK 成绩读取。
- 成绩列表展示。
- 学分统计。
- GPA 计算：五分制、4.3 四分制、原始 4.0 四分制、百分制均分。
- 主修成绩/GPA，可作为独立视图或筛选项。
- 保研/出国两种重复课程策略。
- 本地缓存最近一次成绩快照，避免每次打开页面都访问学校系统。
- 手动刷新，刷新成功后覆盖本地缓存。

暂不做：

- 成绩变化自动监控。
- 定时刷新。
- 推送通知。
- 加权 GPA 自定义权重。
- 研究生成绩接入，除非实现成本很低且不影响本科主线。

### 3.2 数据来源

本科普通成绩：

```text
POST https://zdbk.zju.edu.cn/jwglxt/cxdy/xscjcx_cxXscjIndex.html?doType=query&queryModel.showCount=5000
```

本科主修成绩：

```text
POST https://zdbk.zju.edu.cn/jwglxt/zycjtj/xszgkc_cxXsZgkcIndex.html?doType=query&queryModel.showCount=5000
```

研究生成绩可参考 Celechron 的 GRS 实现，但不作为 v0.1.3 必选项：

```text
POST https://yjsy.zju.edu.cn/dataapi/py/pyXsxk/queryXsxkByXnxqXs
Header: X-Access-Token
```

### 3.3 建议数据结构

成绩数据只读，不写回学校系统。建议新增独立表，不复用 Todo/Schedule：

```text
zju_grades
- id
- course_id
- course_name
- credit
- original_score
- hundred_point
- five_point
- four_point
- four_point_legacy
- gpa_included
- credit_included
- major
- academic_year
- semester
- raw_json
- fetched_at
- created_at
- updated_at
```

也可以先只保存一张缓存快照表，等功能稳定后再拆成规范化成绩表：

```text
zju_grade_snapshots
- id
- source
- fetched_at
- summary_json
- payload_json
```

如果 v0.1.3 只做展示和本地缓存，快照表实现更快，迁移成本更低。

### 3.4 标准化结构

后端 adapter 应先把外部成绩转成统一结构：

```json
{
  "source": "zju_zdbk_grade",
  "external_id": "zdbk:2025-2026:course-id",
  "course_id": "课程号或选课课号",
  "course_name": "课程名",
  "credit": 3.0,
  "original_score": "95",
  "hundred_point": 95,
  "five_point": 5.0,
  "four_point": 4.3,
  "four_point_legacy": 4.0,
  "gpa_included": true,
  "credit_included": true,
  "major": false,
  "academic_year": "2025-2026",
  "semester": "秋冬",
  "raw": {}
}
```

### 3.5 GPA 与学分计算规则

参考 Celechron 的 `Grade` 与 `GpaHelper`：

- 原始成绩可能是数字、字母等级、中文等级、合格/不合格等。
- 百分制、五分制、4.3 四分制、原始 4.0 四分制需要统一换算。
- GPA 课程应排除：弃修、待录、缓考、无效、合格、不合格，以及部分不计绩点课程。
- 已获学分应只统计成绩有效且计入学分的课程。
- 保研 GPA：同一课程取第一次成绩。
- 出国 GPA：同一课程取百分制最高成绩。
- 主修 GPA：可以基于主修成绩接口单独计算。

### 3.6 后端接口建议

复用 `/api/zju` 前缀，新增独立成绩接口：

```text
GET  /api/zju/grades/cache
POST /api/zju/grades/fetch
POST /api/zju/grades/clear-cache
```

如果需要区分普通成绩和主修成绩：

```text
POST /api/zju/grades/fetch
body: { include_major: true }
```

返回建议：

```json
{
  "items": [],
  "summary": {
    "total_credit": 0,
    "earned_credit": 0,
    "gpa_five": 0,
    "gpa_four": 0,
    "gpa_four_legacy": 0,
    "average_hundred": 0,
    "major_gpa": null
  },
  "fetched_at": "2026-07-13T18:00:00",
  "errors": []
}
```

### 3.7 前端交互建议

ZJU 页面分为三个区域：

- 凭据与安全：账号、密码、Pintia Cookie、本地保存/清除。
- 学习任务：预览、导入、撤销。
- 课表与学业：课表导入、成绩与学分概览。

成绩区域建议提供：

- “读取/刷新成绩”按钮。
- 本地缓存状态：上次刷新时间。
- 概览卡片：总学分、已获学分、GPA、主修 GPA。
- 成绩表格：课程名、学分、原始成绩、绩点、是否计入 GPA、是否计入学分、学年学期。
- 切换策略：保研 / 出国。
- 只读提示：成绩只展示和本地缓存，不写回学校系统。

### 3.8 v0.1.3 任务拆分

1. 阅读 Celechron `grade.dart`、`gpa_helper.dart`、`scholar.dart` 中与成绩换算相关逻辑，整理换算规则。
2. 后端新增成绩标准化 dataclass/schema。
3. 后端实现 ZDBK 成绩登录与普通成绩接口读取。
4. 后端实现主修成绩读取，可先作为可选项。
5. 实现成绩换算与 GPA/学分 summary。
6. 新增本地缓存表或快照表。
7. 新增 `/api/zju/grades/*` 接口。
8. 前端 ZJU 页面新增成绩与学分区域。
9. 补充错误脱敏，确保不输出密码、Cookie、CAS/ZDBK session。
10. 验证：后端 compileall、前端 build、一次真实账号冒烟。

### 3.9 v0.1.3 验收标准

- 用户能点击刷新成绩并看到成绩列表。
- 用户能看到学分统计和 GPA 汇总。
- 用户能切换保研/出国重复课程策略。
- 成绩数据可本地缓存，重新打开页面时能读取缓存。
- 刷新失败时不会清空已有缓存。
- 所有功能只读，不向学校系统写入任何数据。

## 4. v0.2.0 之后的边界

v0.1.3 完成后，ZJU 集成的第一阶段闭环结束，项目进入 v0.2.0。v0.2.0 不再承载成绩/GPA 首版实现，而应作为新的产品阶段起点。

暂定后续方向：

- v0.2.x：围绕已有 Todo/Schedule/DailyLog 做更系统的数据整理、复盘或稳定性建设。
- v0.3.x：根据实际使用反馈决定是否扩展更多 ZJU 只读能力。
- v0.4.x：再做日程体验升级，例如周视图、月视图、课程密度更高时的布局优化。

周视图、月视图、课程冲突可视化等日程体验优化明确延后到 v0.4.0，不插入 v0.1.3。

## 5. 安全边界与禁区

以下能力不进入日迹集成，也不提供包装运行入口：

- 自动签到。
- 模拟定位。
- 数字签到暴力尝试。
- 刷课或自动完成学习记录。
- quiz/互动题答案获取。
- 自动提交作业。
- 自动续借。
- 通用脚本平台。
- 外发钉钉/webhook/token 通知。

日志禁止输出：

- ZJU 密码。
- Pintia Cookie。
- 学在浙大 session。
- `iPlanetDirectoryPro`。
- `JSESSIONID`。
- `route`。
- `X-Access-Token`。
- 任何 webhook/token。

## 6. 参考实现与注意事项

### ZJU-live-better

适合参考：

- `courses.zju/reliableTodolist.js`：学习任务抓取覆盖较完整。
- Pintia 任务抓取逻辑：适合作为独立开关保留。

明确不接入：

- `courses.zju/autosign.js`。
- `courses.zju/watchVideo.js`。
- `courses.zju/quizanswer.js`。
- 课件批量下载、Webplus 归档等偏资料管理脚本。

### Celechron

参考路径：`D:\cs\Celechron`

已参考文件：

- `lib/http/zjuServices/zjuam.dart`
- `lib/http/zjuServices/zdbk.dart`
- `lib/http/zjuServices/grs_new.dart`
- `lib/model/session.dart`
- `lib/model/semester.dart`
- `lib/model/grade.dart`
- `lib/utils/gpa_helper.dart`
- `lib/model/scholar.dart`

注意：Celechron 是 GPL-3.0。日迹可以参考接口流程和数据含义，但不应直接复制实现代码，避免许可证风险。

## 7. 当前不立即处理的技术债

- 文案和历史文档中曾出现编码乱码，需要在后续文档整理中逐步清理。
- ZJU 登录链路目前够用，但 Courses、ZDBK、未来 GRS 可以继续抽出更通用的 auth client。
- SQLite 迁移仍是轻量 `PRAGMA table_info + ALTER TABLE` 风格；如果成绩/缓存表继续增加，后续应评估正式迁移工具。
- 课表预览还可以增加筛选、只导入选中项、批次详情，但不阻塞 v0.1.2。
- 日程周视图/月视图延后到 v0.4.0。