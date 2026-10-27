/** Preserve meanings as well as numbers when discussing supplied student work. */
export const DOCUMENT_DISCUSSION_FIDELITY_VERSION = "source-meaning-v3";
export const DOCUMENT_DISCUSSION_FIDELITY_RULE = "含义保真：沿用来源的态度类别；除非来源明确给出等价编码约定，不支持不等于明确反对，未回答也不能归为不支持；不能为了套用固定分类改名。合并、归类或误记的条件推演也须保留实际目标类别：并入某类会影响该类计数，不能在后果中暗换成另一类；假设性讲解也不豁免这种逻辑关系。区分具体缺失字段与整个研究的证据、完成比例，缺一个指标不能推出研究只有一半证据。访谈汇总人数与分类结果不等于已提供逐人原话或逐份原始访谈记录，不能宣称持有未提供的原件；可请学生提供真实原件后再整理。未展示、未记录、尚未验证不等于没有开展或没有设计验证计划；只能说文稿尚未展示，除非学生明确说明未做。观察、访谈、问卷等独立证据通道须分别核对时间、地点和对象范围；观察的时地不能未经依据继承给访谈或全部证据。检查的不只是过去式事实，也包括建议、修改指令和下一步中的来源限定：不能要求学生把所有证据或访谈结论限制为只来自某次观察或观察点，除非原材料明确支持对应通道的该项范围；来源未展示范围应请学生核对，不能补定。正面复述事实须有同一对象、状态与材料层级的来源依据；否定错误说法、讲概念和明确假设举例保持区分。";

const COUNT = "(?:\\d+|[零〇一二两三四五六七八九十百]+)";
function countValue(value: string): number | undefined {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value in digits) return digits[value];
  const parts = value.split("十");
  return parts.length === 2 && (!parts[0] || parts[0] in digits) && (!parts[1] || parts[1] in digits)
    ? (parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0) : undefined;
}

function countsFor(text: string, category: string): Set<number> {
  const counts = new Set<number>();
  for (const pattern of [new RegExp(`(${COUNT})(?:人|位)(?:明确)?${category}`, "gu"),
    new RegExp(`${category}(?:者|人数)?(?:为|有|是|：|:)?\\s*(${COUNT})(?:人|位)?`, "gu")]) {
    for (const match of text.matchAll(pattern)) {
      if (!isAffirmative(text, match.index, match[0].length)) continue;
      const number = countValue(match[1]);
      if (number !== undefined) counts.add(number);
    }
  }
  return counts;
}

/** Local negation/quotation only: a disclaimer elsewhere never exempts a claim. */
function isAffirmative(text: string, index: number, length: number, inspectConditionalRelation = false): boolean {
  const before = text.slice(0, index).split(/[。！？；;\n]/u).at(-1) ?? "";
  const local = before.split(/[，,]/u).at(-1) ?? "";
  // A prohibition of the act ("不能把…并入…，会虚增…") can still
  // assert a false consequence. Negating the whole inference ("不能说…") cannot.
  const negationScope = inspectConditionalRelation ? local.replace(/(?:不能|不应(?:该)?|不要|不得)\s*$/u, "") : local;
  if (/(?:不能|不应|不要|不得|并非|不是|不等于|不代表|无法认定|不能认定)[^。！？；;]{0,36}$/u.test(negationScope)
    || (!inspectConditionalRelation && /(?:如果|假如|假设|例如|比如|举例)[^。！？；;]{0,36}$/u.test(local))
    || /是否(?:确实)?(?:有|存在|记录了?)?$/u.test(local)) return false;
  const afterClaim = text.slice(index + length).split(/[。！？；;\n]/u)[0];
  if (/^(?:的(?:说法|表述|推论)|这一(?:说法|推论)|这个推论|该推论|说法)?(?:是)?(?:不准确|不成立|错误|没有依据|需核对|需要核对)/u.test(afterClaim.trim())) return false;
  if (/(?:请|待你|需要你)(?:先)?(?:提供|上传|附上)[^，,]{0,8}$/u.test(local)) return false;
  if (/(?:文稿|文档|报告|记录)(?:里|中)?$/u.test(local)
    && /^[^，,。！？]{0,8}(?:说明|描述|记录|内容)/u.test(afterClaim)) return false;
  for (const quote of text.matchAll(/[“「『"‘']([^”」』"’'\n]+)[”」』"’']/gu)) {
    if (index < quote.index || index + length > quote.index + quote[0].length) continue;
    const lead = text.slice(0, quote.index).split(/[。！？；;\n]/u).at(-1) ?? "";
    const after = text.slice(quote.index + quote[0].length).split(/[。！？；;\n]/u)[0];
    if (/(?:原文|原句|草稿|错误说法|错误表述|不应说|不能说)[^，,]{0,16}$/u.test(lead)
      || /^(?:[，,]\s*)?(?:(?:这一|这个|该)?(?:说法|推论))?(?:是)?(?:不准确|不成立|没有依据|需核对|需要核对)/u.test(after)) return false;
  }
  return true;
}

function visibleTexts(visible: Record<string, unknown>): string[] {
  const support = visible.support && typeof visible.support === "object" ? visible.support as Record<string, unknown> : {};
  const blocks = Array.isArray(support.replyBlocks) ? support.replyBlocks.flatMap(block =>
    block && typeof block === "object" && typeof block.content === "string" ? [block.content] : []) : [];
  return [...(blocks.length ? blocks : [visible.message]), visible.focus, support.nextStep]
    .filter((value): value is string => typeof value === "string");
}

/** Only diagnose absent channel scope; matching named places/dates stays semantic-reviewed. */
function independentInterviewScope(source: string): { place: boolean; time: boolean } | undefined {
  if (!/观察(?:记录|数据|了|[：:]|[^。！？\n]{0,20}分钟)/u.test(source)) return undefined;
  const clauses = source.split(/[。！？；;\n]/u).filter(clause => /访谈|采访|问卷/u.test(clause)).map(clause => {
    const channelIndex = clause.search(/访谈|采访|问卷/u);
    const prefix = clause.slice(0, channelIndex);
    // An observation's earlier date/place in the same sentence cannot supply
    // a newly introduced interview subject's scope. Shared subjects stay intact.
    return /观察/u.test(prefix) && !/观察[和与、]$/u.test(prefix) ? clause.slice(channelIndex) : clause;
  });
  const records = clauses.filter(clause => /(?:访谈|采访|问卷)[^。！？\n]{0,16}(?:\d+|[一二两三四五六七八九十]+)(?:人|位|份)|(?:访谈|采访|问卷)(?:记录|结果|汇总)[：:]/u.test(clause));
  if (!records.length) return undefined;
  const affirmative = clauses.filter(clause => !/(?:是否|不清楚|未知|未确认|未确定|并非|不是|不在|不应|不要|不得|不等于|不代表|不准确|不成立|没有|未记录|假设|假如|如果|不能认定|不能说|待核实|待补充|待确认|待提供|缺失|不详|计划|打算|预计)/u.test(clause)
    && !/(?:请|要求|帮我|替我|应当|应该|必须|需要|务必)[^。！？]{0,24}(?:限定|限制|设定|当作)|^(?:把|将)(?:访谈|采访|问卷)[^。！？]{0,12}(?:限定|限制|设定|当作)/u.test(clause));
  // Separate dimensions: knowing an interview's location does not supply its time.
  // Explicitly supplied scope may need entity comparison, delegated to the same review.
  return {
    place: affirmative.some(clause => /(?:访谈|采访|问卷)(?:地点|位置)[：:]\s*\S|(?:在|于|来自)[^，,。！？]{0,20}(?:地点|点位|两点|两处|[点站馆室区场街路])|(?:同一|相同)(?:的)?(?:地点|位置)/u.test(clause)),
    time: affirmative.some(clause => /(?:访谈|采访|问卷)(?:时间|日期|时段)[：:]\s*\S|\d{1,2}月\d{1,2}日|\d{4}[-/]\d{1,2}[-/]\d{1,2}|(?:同一|相同|同样)(?:的)?(?:时间|时段)|(?:这次|本次|此次|上述)(?:观察)?(?:期间|时段)/u.test(clause)),
  };
}

function inspectInheritedObservationScope(text: string, scope: { place: boolean; time: boolean }): boolean {
  for (const match of text.matchAll(/(?:全部|所有|整体)?(?:证据|材料|数据)|(?:访谈|采访|问卷)(?:结论|证据|记录|结果|范围)?/gu)) {
    const lead = text.slice(0, match.index).split(/[。！？；;\n]/u).at(-1) ?? "";
    // The subject must be all evidence or the independent channel, not observations.
    if (/(?:观察|观测)(?:所得|得到的|获得的|的)?$/u.test(lead)) continue;
    if (/(?:不可|不宜)[^，,]{0,20}$/u.test(lead)
      || /(?:如果|假如|假设)[^。！？]{0,60}(?:访谈|采访|问卷)[^。！？]{0,60}$/u.test(lead)) continue;
    const tail = text.slice(match.index + match[0].length).split(/[。！？；;\n]/u)[0];
    const restriction = tail.match(/^(?:的(?:来源|适用)?范围)?(?:应|要|需|必须|可以)?(?:只|仅)(?:来自|来源于|限于|限在|限[定制]在)|^(?:的(?:来源|适用)?范围)?(?:应|要|需|必须|可以)?(?:限[定制]|局限)(?:为|在|于)/u);
    if (!restriction || !isAffirmative(text, match.index, match[0].length + restriction[0].length)) continue;
    const destination = tail.slice(restriction[0].length, restriction[0].length + 72);
    if (/(?:是否|需核对|需要核对|尚待核实|尚不清楚)/u.test(destination)) continue;
    if (/(?:说法|限定|判断)(?:是)?(?:不成立|不准确|没有依据)/u.test(destination)) continue;
    const inheritedPlace = /(?:这些|上述|这|两)[^，,。！？]{0,8}(?:观察点|点位|地点|两点|两个点|两处|点)|观察(?:点|地点)/u.test(destination);
    const inheritedTime = /(?:本次|这次|此次|该次|上述)(?:[^，,。！？]{0,8})?(?:观察|时段)/u.test(destination);
    if ((inheritedPlace && !scope.place) || (inheritedTime && !scope.time)) return true;
  }
  return false;
}

/** Conservative source-bound backstops; broader meaning remains model-reviewed. */
export function inspectDocumentDiscussionFidelity(input: {
  documentText: string; request: string; studentHistory?: string[];
}, visible: Record<string, unknown>): string[] {
  const source = input.documentText;
  if (!source.trim()) return [];
  // Student-supplied observations may supplement an older draft; assistant
  // messages and instructions to relabel data never become supporting evidence.
  const studentEvidence = [...(input.studentHistory ?? []), input.request].flatMap(text => text.split(/[。\n]/u))
    .filter(clause => !/[？?]|假设|假如|例如|比如|如果|(?:写|改|说|算)(?:成|为)|当作|帮我|替我|请.{0,8}(?:编|写|生成)/u.test(clause)).join("\n");
  const availableSource = `${source}\n${studentEvidence}`;
  const interviewScope = independentInterviewScope(availableSource);
  const unsupportedCounts = countsFor(source, "不支持");
  const opposedCounts = countsFor(source, "反对");
  const explicitRequestOpposition = countsFor(studentEvidence, "反对");
  const surveyTotals = new Set<number>();
  for (const match of source.matchAll(new RegExp(`(?:访谈|采访|问卷|调查)(?:了|共|共有|总计|合计)?\\s*(${COUNT})(?:人|位)`, "gu"))) {
    const count = countValue(match[1]);
    const sentence = source.slice(match.index).split(/[。！？；;\n]/u)[0];
    if (count !== undefined && /支持|不支持|未回答|赞同|不同意|未答/u.test(sentence)) surveyTotals.add(count);
  }
  const affirmsMatch = (match: RegExpMatchArray & { index: number }, negativeState = false) =>
    isAffirmative(availableSource, match.index, match[0].length)
    && !/(?:尚未|没有|尚无|未提供)[^，,。！？\n]{0,12}$/u.test(availableSource.slice(0, match.index).split(/[。！？\n]/u).at(-1) ?? "")
    && !/^(?:尚未|未|没有|缺失|待)(?:提供|上传|记录|整理|确定)/u.test(availableSource.slice(match.index + match[0].length).trim())
    && (negativeState || !/(?:不能|不应|不要|不等于|不代表|并非|不是|未提供|尚未|没有|尚无)/u.test(match[0]));
  const affirms = (pattern: RegExp, negativeState = false) => [...availableSource.matchAll(pattern)].some(match => affirmsMatch(match, negativeState));
  const originalInterviewCounts = new Set<number>();
  for (const pattern of [
    new RegExp(`(${COUNT})(?:人|位|份)(?:的)?(?:访谈|采访|问卷)(?:的)?(?:原始记录|原始回答|逐人记录|逐份记录)`, "gu"),
    new RegExp(`(${COUNT})份(?:原始|逐人)(?:访谈|采访|问卷)(?:记录|回答)`, "gu"),
    new RegExp(`(?:访谈|采访|问卷)(?:原始记录|原始回答)[：:]?[ \t]*(?:共|共有|已提供)?(${COUNT})(?:人|位|份)`, "gu"),
  ]) {
    for (const match of availableSource.matchAll(pattern)) {
      if (!affirmsMatch(match)) continue;
      const count = countValue(match[1]);
      if (count !== undefined) originalInterviewCounts.add(count);
    }
  }
  const originalInterviewIds = new Set([...availableSource.matchAll(/受访者\s*(\d+|[甲乙丙丁戊己庚辛壬癸])\s*[：:]/gu)]
    .filter(match => isAffirmative(availableSource, match.index, match[0].length)).map(match => match[1]));
  const originalsCover = (count: number) => originalInterviewIds.size >= count || [...originalInterviewCounts].some(provided => provided >= count);
  const sourceHasEvidenceRatio = affirms(/(?:研究问题|整个研究|项目|全部证据|证据总量|证据完成度)[^。！？\n]{0,30}(?:一半|半数|\d+\s*%|百分之|[一二三四五六七八九十]+分之)/gu);
  const sourceHasMissingField = /缺失|未记录|未测量|未填写|漏填|漏记/u.test(source) && /\d/u.test(source);
  const verificationPending = /(?:尚未|还未|未|待)(?:完成)?(?:验证|测试|试验|实验)/u.test(source);
  const explicitlyNoPlan = affirms(/(?:没有|没|未|尚未|还没)(?:开始)?(?:设计|制定|确定)[^。！？\n]{0,16}(?:验证|测试|试验|实验)|(?:验证|测试|试验|实验)(?:方案|计划|方法)[^。！？\n]{0,8}(?:未设计|未制定|未确定|待设计|待制定|待确定)/gu, true);
  const explicitBinaryDefinition = affirms(/(?:操作性定义|编码规则|本题约定|本问卷定义|本调查定义)[^。！？\n]{0,36}不支持[^。！？\n]{0,18}(?:为|表示|等于|即)[^。！？\n]{0,6}反对/gu);
  const issues = new Set<string>();
  for (const text of visibleTexts(visible)) {
    if (interviewScope && inspectInheritedObservationScope(text, interviewScope)) {
      issues.add("来源含观察和独立访谈/问卷记录，不能把观察的时地范围未经依据限定给访谈或全部证据；修改建议也须分别核对各通道范围，未提供的范围请学生核实。");
    }
    for (const count of countsFor(text, "反对")) {
      if (unsupportedCounts.has(count) && !opposedCounts.has(count) && !explicitRequestOpposition.has(count) && !explicitBinaryDefinition) {
        issues.add("来源的‘不支持’被改报为‘反对’，人数相同也不代表态度含义相同；请沿用原记录类别。");
      }
    }
    if (unsupportedCounts.size && countsFor(source, "(?:未回答|未答|未作答)").size && !explicitBinaryDefinition) {
      // Hypothetical misclassification is a valid teaching example, but its
      // consequence must count the stated destination category, not another one.
      for (const match of text.matchAll(/(?:把|将)[“”「」"‘’']*(?:未回答|未答|未作答|态度未知)[“”「」"‘’']*(?:者|的人)?[^，,。！？；;\n]{0,8}?(?:并入|归入|计入|算入|记为|合并到|误记为?)[“”「」"‘’']*不支持[“”「」"‘’']*[^。！？；;\n]{0,24}?(?:多出|虚增|增加|多算|新增)[^。！？；;\n]{0,8}反对(?:者|人数)/gu)) {
        if (isAffirmative(text, match.index, match[0].length, true)
          && !/(?:不能|不应|不要|不等于|不代表|并非|不是|不会)[^，,。！？]{0,12}(?:多出|虚增|增加|多算|新增)/u.test(match[0])) {
          issues.add("合并/误记的条件推演偷换了目标类别：并入‘不支持’影响的是不支持人数，不能说因此多出反对者；保留目标类别与计数后果的一致关系。");
        }
      }
    }
    // A current-record checking list must not relabel its categories either.
    if (unsupportedCounts.size && !opposedCounts.size && !explicitRequestOpposition.size && !explicitBinaryDefinition) {
      for (const match of text.matchAll(/不支持[”"’']?(?:是|表示|意味着|等于|即|就是)[^，,。！？；;\n]{0,18}反对(?:意见|态度)?|不支持(?:者|的人|的受访者)[^，,。！？；;\n]{0,8}(?:计入|算作|归入|归为)反对(?:人数|类别|者)/gu)) {
        if (isAffirmative(text, match.index, match[0].length) && !/(?:不|未|否)/u.test(match[0].slice(3)))
          issues.add("不能把‘不支持’直接定义或计入‘明确反对’；只有来源明确给出该操作性定义时才能按该编码解释，通常应保留原类别。");
      }
      for (const match of text.matchAll(/(?:把|按|将)(?:总样本|总人数)[、，,]支持[、，,]反对[、，,]未回答(?:四个数|人数|分开|分别)/gu)) {
        if (isAffirmative(text, match.index, match[0].length)) issues.add("核对当前记录时将‘不支持’类别改列为‘反对’；保留来源各类别名称。");
      }
    }
    if (sourceHasMissingField && !sourceHasEvidenceRatio) {
      for (const match of text.matchAll(/(?:研究问题|整个研究|整个项目|全部证据|研究的证据)[^。！？；;\n]{0,36}?(?:只有|仅有|只剩|缺少了?|缺了)(?:一半|半数|\d+\s*%|百分之[零一二三四五六七八九十百]+|[一二三四五六七八九十]+分之[一二三四五六七八九十]+)(?:的)?(?:证据|材料)/gu)) {
        if (isAffirmative(text, match.index, match[0].length) && !/(?:不能|不应|不要|并非|不是|无法|不等于)/u.test(match[0])) {
          issues.add("具体字段缺失不能推出整个研究的证据占比；只指出实际缺失的字段及其影响，不虚构‘一半证据’等比例。");
        }
      }
    }
    if (surveyTotals.size) {
      for (const match of text.matchAll(new RegExp(`(?:已有|现有|提供的|已提供的)(?:的)?\\s*(${COUNT})(?:人|位|份)(?:的)?(?:访谈|采访|问卷)(?:的)?(?:原始记录|原始回答|逐人记录|逐份记录)`, "gu"))) {
        if (surveyTotals.has(countValue(match[1]) ?? -1) && !originalsCover(countValue(match[1]) ?? Infinity) && isAffirmative(text, match.index, match[0].length)) {
          issues.add("来源只展示访谈/调查汇总，不能断言已经提供同人数的原始或逐份记录；可整理现有汇总，或请学生提供真实原件后再整理。");
        }
      }
    }
    if (verificationPending && !explicitlyNoPlan) {
      for (const match of text.matchAll(/(?:还|仍|尚)?(?:没有|没|未)(?:开始)?(?:设计|制定|确定)[^。！？；;\n]{0,16}(?:验证|测试|试验|实验)/gu)) {
        if (isAffirmative(text, match.index, match[0].length)) issues.add("‘尚未验证’不证明尚未设计验证计划；只能说明文稿未展示计划，不能把未知的准备状态断言为未做。");
      }
    }
  }
  return [...issues];
}
