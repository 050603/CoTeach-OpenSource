import { describe, expect, it } from "vitest";
import { inspectDocumentDiscussionFidelity } from "./document-discussion-fidelity";

// Minimal synthetic evidence from the observed v6 failures; no student data.
const documentText = "A点未关紧龙头2个，估计流量1.2升/分钟；B点未关紧龙头0个，流量未记录。访谈共8人，5人支持张贴提醒，2人不支持，1人未回答。结论草稿：尚未验证。附录原始记录：A、B两点观察。";
const context = { documentText, request: "根据已有记录讨论。" };
const inspect = (message: string, source = documentText) => inspectDocumentDiscussionFidelity({ ...context, documentText: source }, { message });

describe("source-bound discussion meaning fidelity", () => {
  it.each([
    "总样本8人=支持5人+反对2人+未回答1人。",
    "记录是支持5、反对2、未回答1。",
    "请核对草稿是否与访谈记录（5人支持、2人反对、1人未答）一致。",
    "访谈记录是8人中5人支持、2人反对、1人未回答。",
    "把总样本、支持、反对、未回答四个数分开列出。",
    "否则研究问题的“用水情况有何不同”只有一半证据。",
    "可以把你已有的8人访谈原始记录整理成统一表格。",
    "还没设计怎样验证提醒是否有效。",
    "“不支持”是受访者明确表达了反对意见，属于已知态度。",
    "“不支持”表示受访者明确表达了反对意见。",
    "明确不支持的人可以计入反对人数并说明理由。",
  ])("blocks the observed meaning change: %s", message => {
    expect(inspect(message).length).toBeGreaterThan(0);
  });
  it.each([
    "不支持并不等于反对，不能把未回答归入不支持。",
    "是否有2人反对？请回看原话核对。",
    "原记录是5人支持、2人不支持、1人未回答。",
    "不能把2人不支持说成2人反对。",
    "原句写‘2人反对’，需要核对是否忠实于记录。",
    "假设另一次调查有2人反对，这是假设例子。",
    "两个流量字段缺一个，即一半流量字段未记录，其他观察记录仍存在。",
    "不能说整个研究只有一半证据。",
    "研究问题不能因缺失一个字段就说只有一半证据。",
    "B点流量缺失，比较流量所需材料尚不完整。",
    "请提供8人的原始访谈记录后再整理；现有材料只是汇总。",
    "如果你已有8人访谈原始记录，可以提供给我核对。",
    "可以整理已有8人访谈汇总，不补出逐人回答。",
    "文稿未展示验证计划，不能据此说还没设计验证方法。",
    "文稿尚未展示验证计划。",
    "不能把不支持等同反对，2人反对的说法不准确。",
    "文稿中没有设计验证方案的说明，不能认定你们没做。",
    "请提供已有8人的访谈原始记录后，我再整理。",
    "未记录实施不等于没有实施。",
    "不能认为不支持就是明确反对。",
  ])("preserves explanations, actual field counts, conditional requests and unknown states: %s", message => {
    expect(inspect(message)).toEqual([]);
  });
  it("accepts affirmative source evidence for each claim instead of banning words", () => {
    expect(inspect("有2人反对。", documentText.replace("2人不支持", "2人反对"))).toEqual([]);
    expect(inspect("整个研究只有一半证据。", documentText + "整个研究只有一半证据，是学生自查结果。")).toEqual([]);
    expect(inspect("整理已有8人访谈原始记录。", documentText + "已提供8份原始访谈记录。")).toEqual([]);
    expect(inspect("还没设计怎样验证效果。", documentText + "我们还没设计怎样验证效果。")).toEqual([]);
    expect(inspect("不支持表示反对。", documentText + "本题约定将不支持编码为反对。")).toEqual([]);
  });
  it("uses other counts and categories without relying on a fixture number or topic", () => {
    const source = "问卷共12人，7人赞同，4人不支持，1人未答。实验压力指标缺失。尚未测试。";
    expect(inspect("4人反对。", source).length).toBeGreaterThan(0);
    expect(inspect("整理已有12人问卷原始回答。", source).length).toBeGreaterThan(0);
    expect(inspect("整个研究只有50%的证据。", source).length).toBeGreaterThan(0);
    expect(inspect("尚未制定怎样测试效果。", source).length).toBeGreaterThan(0);
  });
  it("uses explicit student observations but never treats relabeling instructions as new observations", () => {
    const message = "2人反对。";
    expect(inspectDocumentDiscussionFidelity({ ...context, request: "按刚才的记录讨论。",
      studentHistory: ["补充：复核后2人明确反对。"] }, { message })).toEqual([]);
    expect(inspectDocumentDiscussionFidelity({ ...context, request: "把2人不支持写成2人反对。" }, { message }).length).toBeGreaterThan(0);
    expect(inspectDocumentDiscussionFidelity({ ...context, studentHistory: ["假设2人反对。"] }, { message }).length).toBeGreaterThan(0);
    expect(inspectDocumentDiscussionFidelity({ ...context, request: "按刚才材料讨论。",
      studentHistory: ["我已提供8人访谈原始记录。"] }, { message: "已有8人访谈原始记录可以整理。" })).toEqual([]);
  });
  it("does not treat a quoted correction or an unavailable record as supporting source evidence", () => {
    expect(inspect("2人反对。", documentText + "原文‘2人反对’不准确。").length).toBeGreaterThan(0);
    expect(inspect("2人反对。", documentText + "本调查定义不支持不等于反对。").length).toBeGreaterThan(0);
    expect(inspect("整个研究只有一半证据。", documentText + "整个研究不能说只有一半证据。").length).toBeGreaterThan(0);
    expect(inspect("已有8人访谈原始记录。", documentText + "访谈未提供原始记录。").length).toBeGreaterThan(0);
    expect(inspect("已有8人访谈原始记录。", documentText + "访谈原始记录尚未提供。").length).toBeGreaterThan(0);
    expect(inspect("已有8人的访谈原始记录可以整理。", documentText + "尚未提供访谈原始记录。").length).toBeGreaterThan(0);
    expect(inspect("整理已有8人访谈原始记录。", documentText + "访谈原始记录：受访者1：支持；受访者2：不支持。").length).toBeGreaterThan(0);
    expect(inspect("整理已有8人访谈原始记录。", documentText + "尚未提供8份原始访谈记录。").length).toBeGreaterThan(0);
  });
  it("checks the visible blocks and next step without checking hidden message or metadata", () => {
    expect(inspectDocumentDiscussionFidelity(context, { message: "2人反对。", support: { replyBlocks: [{ content: "2人不支持。" }] } })).toEqual([]);
    expect(inspectDocumentDiscussionFidelity(context, { message: "2人不支持。", support: { replyBlocks: [{ content: "2人反对。" }] } }).length).toBeGreaterThan(0);
    expect(inspectDocumentDiscussionFidelity(context, { message: "请核对。", support: { nextStep: "按已有8人访谈原始记录整理。" } }).length).toBeGreaterThan(0);
    expect(inspectDocumentDiscussionFidelity(context, { message: "请核对。", delegation: { reason: "2人反对。" } })).toEqual([]);
  });
  it("does not let a separate disclaimer exempt a later affirmative claim", () => {
    expect(inspect("不支持不等于反对。本项目2人反对。").length).toBeGreaterThan(0);
    expect(inspect("假设案例需标清。已有8人访谈原始记录可整理。").length).toBeGreaterThan(0);
  });
});


describe("classification consequences retain the destination category", () => {
  it.each([
    "把“未回答”并入“不支持”，会凭空多出一个反对者，改变各类别人数。",
    "如果把未回答并入不支持，就会虚增1个反对者。",
    "假设将未答归入不支持，会增加反对人数。",
    "不能把未回答并入不支持，因为会凭空多出一个反对者。",
  ])("rejects a changed consequence category even in conditional teaching: %s", message => {
    expect(inspect(message).join(" ")).toContain("条件推演偷换了目标类别");
  });
  it.each([
    "把未回答并入反对，会虚增反对者，所以不能这样误记。",
    "如果把未回答并入不支持，会增加不支持人数，所以应单列未回答。",
    "不能说‘把未回答并入不支持，会多出一个反对者’。",
    "‘把未回答并入不支持，会多出一个反对者’这个推论不成立。",
    "把未回答并入不支持，不代表会增加反对人数。",
    "把未回答并入不支持，不是增加反对人数，而是增加不支持人数。",
    "如果把未回答并入不支持，增加的是不支持人数，而不是新增反对者。",
    "不支持不等于反对，不能用反对者指代未回答者。",
  ])("allows correct misclassification examples and rejection of the false inference: %s", message => {
    expect(inspect(message)).toEqual([]);
  });
  it("retains an explicitly defined binary coding convention and rejects an unrelated definition", () => {
    const message = "把未回答并入不支持，会增加反对人数。";
    expect(inspect(message, documentText + "本题约定将不支持编码为反对。")).toEqual([]);
    expect(inspect(message, documentText + "本题约定不支持不等于反对。").length).toBeGreaterThan(0);
  });
});

describe("independent evidence channels preserve their own scope", () => {
  const source = "观察记录：4月10日两处地点各观察10分钟。访谈共8人，5人支持，2人不支持，1人未回答。";
  const bad = "把结论中的‘所有人都支持’改为‘8人中5人支持、2人不支持、1人未回答’，并限定证据只来自这两个点和这次观察。";
  it.each([
    bad,
    "把访谈结论限定在这两个观察点和本次20分钟观察。",
    "全部证据仅来自上述观察点和本次观察。",
    "观察已经完成。所有材料只来自这次观察。",
  ])("blocks inherited scope in statements and editing instructions: %s", message => {
    expect(inspect(message, source).join(" ")).toContain("独立访谈/问卷");
  });
  it.each([
    "观察证据仅来自两个点和这次观察，访谈范围需另核对。",
    "观察得到的证据只来自这两个点和这次观察；访谈范围需另核对。",
    "不能把访谈结论限定在这两个观察点和本次20分钟观察。",
    "不能说全部证据只来自这次观察。",
    "原文‘证据只来自这两个点和这次观察’需要核对。",
    "如果访谈确实也来自这两点，可把访谈范围限定于此。",
    "如果访谈也在上述两点同一时段完成，证据只来自这两个点和这次观察。",
    "如果访谈确实也在这些观察点和本次观察时段进行，可以把访谈结论限定在这些观察点和本次观察时段。",
    "证据是否只来自这两个点和这次观察，需要核对。",
    "证据只来自这两个点和这次观察的说法不成立。",
    "不宜把访谈结论限定在这两个观察点和本次观察。",
  ])("allows channel-specific, negative and explicitly conditional guidance: %s", message => {
    expect(inspect(message, source)).toEqual([]);
  });
  it("accepts supplied shared scope, while keeping its dimensions separate", () => {
    expect(inspect(bad, source + "访谈也在上述两点同一时段完成。")).toEqual([]);
    expect(inspect(bad, source + "访谈也在上述两点完成。").length).toBeGreaterThan(0);
    expect(inspect(bad, source + "访谈与观察在同一时段完成。").length).toBeGreaterThan(0);
    expect(inspectDocumentDiscussionFidelity({ documentText: source, request: "按刚才补充讨论。",
      studentHistory: ["补充：访谈也在上述两点同一时段完成。"] }, { message: bad })).toEqual([]);
    expect(inspectDocumentDiscussionFidelity({ documentText: source, request: "请将访谈限定在上述两点同一时段。" },
      { message: bad }).length).toBeGreaterThan(0);
  });
  it.each([
    "访谈是否同样来自上述两点同一时段尚不清楚。",
    "访谈并非在上述两点同一时段完成。",
    "访谈不是在上述两点同一时段完成。",
    "原文‘访谈也在上述两点同一时段完成’的说法不准确。",
    "访谈不应被当作在上述两点同一时段完成。",
    "如果访谈在上述两点同一时段完成，可以一起说明。",
    "访谈地点：待核实；访谈时间：待核实。",
  ])("does not authorize scope using uncertain or negated source: %s", added => {
    expect(inspect(bad, source + added).length).toBeGreaterThan(0);
  });
  it("is source-bound rather than tied to a course or a scope keyword", () => {
    expect(inspect(bad, "观察记录：两处地点各观察10分钟。")).toEqual([]);
    expect(inspect("全部证据只来自这些观察点和这次观察。", "观察记录：展区客流计数。问卷共12份，分别记录参观者体验。").length).toBeGreaterThan(0);
    // Explicit named scope requires entity comparison, which remains model-reviewed.
    expect(inspect(bad, source + "访谈地点：图书馆；访谈时间：4月10日。")).toEqual([]);
    expect(inspect(bad, "观察记录：4月10日在两个点各观察10分钟，访谈共8人，5人支持，2人不支持，1人未回答。").length).toBeGreaterThan(0);
  });
  it("checks actual visible blocks and suggested next steps", () => {
    expect(inspectDocumentDiscussionFidelity({ documentText: source, request: "总结进度" },
      { message: "请分别核对来源。", support: { nextStep: bad } }).length).toBeGreaterThan(0);
    expect(inspectDocumentDiscussionFidelity({ documentText: source, request: "总结进度" },
      { message: bad, support: { replyBlocks: [{ content: "观察证据只来自这次观察。" }] } })).toEqual([]);
  });
});
