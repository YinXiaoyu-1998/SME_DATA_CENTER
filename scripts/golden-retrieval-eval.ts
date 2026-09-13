import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

type GoldenFileType = "md" | "txt" | "docx";
type GoldenStatus = "active" | "archived";
type GoldenCallerId = "admin" | "baoli_employee" | "suzhou_employee" | "disabled_employee";
type RetrievalMode = "dense-only" | "lexical-only" | "hybrid" | "hybrid+rerank";

interface GoldenSection {
  id: string;
  heading: string;
  text: string;
  keywords: string[];
}

interface GoldenDocument {
  id: string;
  title: string;
  fileType: GoldenFileType;
  confidentialityLevel: number;
  status: GoldenStatus;
  currentContentVersion: number;
  indexedContentVersion: number;
  sections: GoldenSection[];
}

interface GoldenQuerySeed {
  query: string;
  type:
    | "exact_keyword"
    | "semantic_paraphrase"
    | "chinese_synonym"
    | "business_term"
    | "table_or_clause"
    | "ambiguous"
    | "no_answer"
    | "permission_hidden"
    | "archived_hidden"
    | "stale_payload";
  callerId: GoldenCallerId;
  relevantChunkIds: string[];
  unacceptableChunkIds: string[];
  expectedVisibleDocumentIds: string[];
  expectedTerms: string[];
  gradedRelevance: Record<string, number>;
}

interface GoldenChunk {
  chunkId: string;
  documentId: string;
  confidentialityLevel: number;
  status: GoldenStatus;
  currentContentVersion: number;
  indexedContentVersion: number;
  text: string;
  keywords: string[];
}

interface RankedChunk extends GoldenChunk {
  score: number;
}

interface Caller {
  id: GoldenCallerId;
  disabled: boolean;
  clearance: number;
}

interface ModeMetrics {
  mode: RetrievalMode;
  queryCount: number;
  answerableQueryCount: number;
  hitRateAt5: number;
  recallAt10: number;
  precisionAt5: number;
  mrrAt10: number;
  ndcgAt10: number;
  noAnswerFalsePositiveRate: number;
  permissionLeakCount: number;
  archivedLeakCount: number;
  stalePayloadLeakCount: number;
  disabledEmployeeLeakCount: number;
  latencyMs: {
    p50: number;
    p95: number;
  };
}

interface GoldenEvaluationReport {
  ok: boolean;
  generatedAt: string;
  corpus: {
    documentCount: number;
    queryCount: number;
    fileTypes: Record<GoldenFileType, number>;
  };
  gates: {
    hitRateAt5Min: number;
    recallAt10Min: number;
    mrrAt10Min: number;
    leakCountMax: number;
  };
  metrics: ModeMetrics[];
  notes: string[];
}

const RETRIEVAL_MODES: RetrievalMode[] = ["dense-only", "lexical-only", "hybrid", "hybrid+rerank"];

const CALLERS: Record<GoldenCallerId, Caller> = {
  admin: {
    id: "admin",
    disabled: false,
    clearance: 3
  },
  baoli_employee: {
    id: "baoli_employee",
    disabled: false,
    clearance: 1
  },
  suzhou_employee: {
    id: "suzhou_employee",
    disabled: false,
    clearance: 2
  },
  disabled_employee: {
    id: "disabled_employee",
    disabled: true,
    clearance: 0
  }
};

const SYNONYM_GROUPS = [
  ["差评", "负面评价", "客诉", "投诉", "bad review"],
  ["会员", "储值", "积分", "member", "loyalty"],
  ["外卖", "配送", "骑手", "meituan", "delivery"],
  ["毛利", "利润", "gross margin", "成本"],
  ["库存", "盘点", "stock", "inventory"],
  ["排班", "班次", "shift", "考勤"],
  ["食品安全", "留样", "温度", "HACCP"],
  ["发票", "报销", "invoice", "reimbursement"],
  ["供应商", "验收", "采购", "purchase"],
  ["优惠券", "折扣", "coupon", "promotion"],
  ["门店", "商圈", "store", "区域"],
  ["新品", "试吃", "上新", "menu launch"],
  ["退款", "退单", "reverse order", "售后"],
  ["桌台", "翻台", "table turnover", "开台"],
  ["数据口径", "字段", "schema", "指标"]
];

const GOLDEN_DOCUMENTS: GoldenDocument[] = [
  doc("doc_feedback_sop", "保利店差评处理SOP.md", "md", 0, "active", [
    section(
      "response",
      "差评响应流程",
      "差评或负面评价出现后，值班经理必须在15分钟内联系顾客，记录客诉原因、订单号、菜品名称和补偿动作。",
      ["差评", "负面评价", "客诉", "15分钟", "补偿"]
    ),
    section(
      "register",
      "登记表字段",
      "登记表包含处理人、联系电话、订单来源、退款金额、复盘结论。禁止把顾客手机号写入公开备注。",
      ["登记表", "退款", "复盘", "手机号"]
    )
  ]),
  doc("doc_member_manual", "会员储值与积分手册.docx", "docx", 0, "active", [
    section(
      "points",
      "会员积分规则",
      "会员每消费1元获得1积分，储值赠送金额不再重复计分。积分过期提醒需要提前7天发送。",
      ["会员", "积分", "储值", "过期提醒"]
    ),
    section(
      "refund",
      "会员退款条款",
      "会员退款时先冲减赠送余额，再冲减本金；异常退款必须由店长复核。",
      ["会员退款", "赠送余额", "店长复核"]
    )
  ]),
  doc("doc_delivery_playbook", "外卖高峰运营记录.txt", "txt", 0, "active", [
    section(
      "peak",
      "外卖高峰",
      "午高峰配送拥堵时，前台每10分钟查看骑手等待单，超过8分钟的订单优先打包。",
      ["外卖", "骑手", "8分钟", "打包"]
    ),
    section(
      "platform",
      "平台备注",
      "美团外卖异常需要在平台备注写明缺货、改菜或退款原因，不得写内部绩效评价。",
      ["美团", "外卖", "缺货", "退款"]
    )
  ]),
  doc("doc_margin_review", "菜品毛利复盘.md", "md", 0, "active", [
    section(
      "gross_margin",
      "毛利分析",
      "牛腩饭毛利率低于目标3个百分点，主要原因是牛肉采购成本上涨和出餐损耗增加。",
      ["毛利", "牛腩饭", "采购成本", "损耗"]
    ),
    section(
      "actions",
      "改进动作",
      "下周先调整备货量，不直接涨价；若连续三天毛利仍低于目标，再评估套餐结构。",
      ["备货量", "涨价", "套餐结构"]
    )
  ]),
  doc("doc_inventory_check", "库存盘点规则.docx", "docx", 0, "active", [
    section(
      "daily",
      "每日盘点",
      "冻品、米面、一次性餐盒每天闭店后盘点，差异超过2%需要拍照并提交原因。",
      ["库存", "盘点", "冻品", "餐盒", "2%"]
    ),
    section(
      "loss",
      "损耗处理",
      "报损必须选择破损、过期、试制或员工餐，不允许用其他备注掩盖盘亏。",
      ["报损", "过期", "盘亏"]
    )
  ]),
  doc("doc_shift_handover", "班次交接清单.txt", "txt", 0, "active", [
    section(
      "handover",
      "交接",
      "早晚班交接必须确认备用金、未完成退款、预订单、设备报修和员工考勤异常。",
      ["排班", "交接", "备用金", "考勤"]
    ),
    section(
      "late",
      "迟到处理",
      "员工迟到超过10分钟要在考勤系统备注原因，不能只在微信群口头说明。",
      ["迟到", "考勤", "微信群"]
    )
  ]),
  doc("doc_food_safety", "食品安全留样制度.md", "md", 0, "active", [
    section(
      "sample",
      "留样要求",
      "每批卤味和凉菜留样不少于125克，冷藏保存48小时，容器必须标注日期、餐段和操作人。",
      ["食品安全", "留样", "125克", "48小时"]
    ),
    section("temperature", "温度记录", "冷藏柜温度超过8℃持续20分钟，需要暂停出品并通知店长。", [
      "温度",
      "8℃",
      "暂停出品"
    ])
  ]),
  doc("doc_invoice_policy", "发票与报销说明.docx", "docx", 0, "active", [
    section(
      "invoice",
      "发票",
      "企业客户开票需要完整抬头、税号和消费明细，个人发票不得补录公司税号。",
      ["发票", "税号", "消费明细"]
    ),
    section("reimburse", "报销", "门店临采报销必须附采购小票、验收照片和店长审批截图。", [
      "报销",
      "采购小票",
      "验收照片"
    ])
  ]),
  doc("doc_supplier_receiving", "供应商验收SOP.txt", "txt", 0, "active", [
    section(
      "receive",
      "验收",
      "供应商送货时核对品名、规格、批次和温度；缺少检疫票的肉类不得入库。",
      ["供应商", "验收", "批次", "检疫票"]
    ),
    section("reject", "拒收", "拒收记录必须写明数量、原因、照片编号和采购负责人。", [
      "拒收",
      "采购",
      "照片编号"
    ])
  ]),
  doc("doc_coupon_rules", "优惠券使用规则.md", "md", 0, "active", [
    section(
      "stack",
      "叠加规则",
      "满减券不能与员工餐折扣叠加，平台补贴券可以与会员积分抵扣同时使用。",
      ["优惠券", "满减", "员工餐折扣", "会员积分"]
    ),
    section("abuse", "异常核查", "同一手机号一天核销超过5张券，需要提交异常核查记录。", [
      "手机号",
      "核销",
      "异常"
    ])
  ]),
  doc("doc_store_area", "商圈门店对比.docx", "docx", 0, "active", [
    section("area", "商圈", "保利店工作日午餐以写字楼客群为主，晚餐受社区客流影响更大。", [
      "门店",
      "商圈",
      "写字楼",
      "社区客流"
    ]),
    section("compare", "对比", "苏州店游客订单占比更高，不能直接套用保利店午高峰排班。", [
      "苏州店",
      "游客订单",
      "排班"
    ])
  ]),
  doc("doc_menu_launch", "新品上新检查表.txt", "txt", 0, "active", [
    section("trial", "试吃", "新品上新前需要完成员工试吃、过敏原标注、出餐时长测试和毛利复核。", [
      "新品",
      "试吃",
      "过敏原",
      "毛利"
    ]),
    section("launch", "上线", "菜单上线当天，收银端、外卖平台和厨房看板名称必须一致。", [
      "菜单",
      "外卖平台",
      "厨房看板"
    ])
  ]),
  doc("doc_refund_aftercare", "退款售后流程.md", "md", 0, "active", [
    section(
      "refund",
      "退款",
      "退单先判断是否已出餐；未出餐可直接退款，已出餐需要记录逆向订单原因。",
      ["退款", "退单", "已出餐", "逆向订单"]
    ),
    section("aftercare", "售后", "售后补偿不得超过订单实付金额，超过需区域经理批准。", [
      "售后",
      "补偿",
      "区域经理"
    ])
  ]),
  doc("doc_table_turnover", "桌台翻台率说明.docx", "docx", 0, "active", [
    section(
      "metric",
      "翻台率",
      "翻台率按桌台使用次数除以桌台数量计算，宴会包间不纳入普通堂食桌台口径。",
      ["桌台", "翻台率", "桌台使用次数", "口径"]
    ),
    section("improve", "提升", "排队超过20分钟时，迎宾需提示可选外带或小桌拼桌。", [
      "排队",
      "20分钟",
      "拼桌"
    ])
  ]),
  doc("doc_schema_dictionary", "结构化字段口径.md", "md", 0, "active", [
    section(
      "business",
      "营业字段",
      "营业额、订单营业收入、优惠金额和逆向订单量来自business数据集，不能从自然语言问题生成SQL。",
      ["数据口径", "business", "营业额", "逆向订单量", "SQL"]
    ),
    section(
      "dishes",
      "菜品字段",
      "菜品销售数量、菜品总收入和销量占比来自dishes数据集，查询必须使用受控字段名。",
      ["dishes", "菜品销售数量", "菜品总收入", "受控字段"]
    )
  ]),
  doc("doc_suzhou_private", "苏州店私有促销方案.md", "md", 2, "active", [
    section(
      "campaign",
      "游客套餐",
      "苏州店游客套餐在周末午餐使用，赠券限次日堂食，不适用于保利店。",
      ["苏州店", "游客套餐", "赠券", "周末午餐"]
    ),
    section("budget", "预算", "促销预算由苏州店店长单独审批，保利店员工不可见。", [
      "苏州店",
      "预算",
      "审批"
    ])
  ]),
  doc("doc_suzhou_staffing", "苏州店排班备忘.txt", "txt", 2, "active", [
    section("staffing", "排班", "苏州店节假日增加迎宾和打包岗，游客高峰在14点后仍可能持续。", [
      "苏州店",
      "排班",
      "节假日",
      "游客高峰"
    ]),
    section("handover", "交接", "临时工排班需当天确认健康证和工时记录。", [
      "临时工",
      "健康证",
      "工时"
    ])
  ]),
  doc("doc_private_salary", "个人薪酬备注.docx", "docx", 3, "active", [
    section("salary", "薪酬", "个人薪酬、绩效扣款和银行账号不得进入门店共享检索。", [
      "薪酬",
      "绩效扣款",
      "银行账号",
      "个人"
    ]),
    section("privacy", "隐私", "任何员工不得通过证据检索看到他人的个人薪酬备注。", [
      "隐私",
      "个人薪酬",
      "证据检索"
    ])
  ]),
  doc("doc_archived_old_menu", "已归档旧菜单.md", "md", 0, "archived", [
    section("old", "旧菜单", "2025年旧菜单中的番茄牛腩套餐已下架，归档后不能出现在普通检索。", [
      "旧菜单",
      "下架",
      "番茄牛腩"
    ]),
    section("archive", "归档原因", "该文档仅保留审计用途，不允许作为当前菜单证据。", [
      "归档",
      "审计",
      "当前菜单"
    ])
  ]),
  {
    ...doc("doc_stale_recipe", "已更新配方旧索引.txt", "txt", 0, "active", [
      section("recipe", "旧配方", "旧索引仍包含辣油配方比例1:3，但当前内容版本已经改为1:4。", [
        "旧索引",
        "辣油配方",
        "1:3",
        "版本"
      ]),
      section("stale", "版本检查", "内容版本不一致的Qdrant payload必须由MySQL复核丢弃。", [
        "stale",
        "Qdrant",
        "MySQL复核",
        "丢弃"
      ])
    ]),
    currentContentVersion: 2,
    indexedContentVersion: 1
  }
];

export function buildGoldenJudgedQueries(): GoldenQuerySeed[] {
  return GOLDEN_DOCUMENTS.flatMap((document, documentIndex) => {
    const primary = document.sections[0] as GoldenSection;
    const secondary = document.sections[1] as GoldenSection;
    const primaryChunkId = chunkId(document, primary);
    const secondaryChunkId = chunkId(document, secondary);
    const visibleToBaoli = isVisibleTo(CALLERS.baoli_employee, document);
    const hiddenType = hiddenQueryType(document);
    const callerId: GoldenCallerId = visibleToBaoli ? "baoli_employee" : "baoli_employee";
    const expectedVisibleDocumentIds = visibleToBaoli ? [document.id] : [];
    const relevantChunkIds = visibleToBaoli ? [primaryChunkId] : [];
    const secondaryRelevantChunkIds = visibleToBaoli ? [secondaryChunkId] : [];
    const unacceptableChunkIds = visibleToBaoli ? [] : [primaryChunkId, secondaryChunkId];
    const firstKeyword = primary.keywords[0] ?? primary.heading;
    const secondKeyword = secondary.keywords[0] ?? secondary.heading;
    const synonym = synonymFor(firstKeyword);

    return [
      judged({
        query: `${firstKeyword} ${primary.heading} 怎么处理`,
        type: visibleToBaoli ? "exact_keyword" : hiddenType,
        callerId,
        relevantChunkIds,
        unacceptableChunkIds,
        expectedVisibleDocumentIds,
        expectedTerms: [firstKeyword, primary.heading, synonym],
        gradedRelevance: relevance(primaryChunkId, secondaryChunkId, visibleToBaoli)
      }),
      judged({
        query: `${synonym} 的门店流程是什么`,
        type: visibleToBaoli ? "chinese_synonym" : hiddenType,
        callerId,
        relevantChunkIds,
        unacceptableChunkIds,
        expectedVisibleDocumentIds,
        expectedTerms: [firstKeyword, synonym, primary.heading],
        gradedRelevance: relevance(primaryChunkId, secondaryChunkId, visibleToBaoli)
      }),
      judged({
        query: `${document.title.replace(/\.(md|txt|docx)$/u, "")} ${secondKeyword} 字段或条款`,
        type: visibleToBaoli ? "table_or_clause" : hiddenType,
        callerId,
        relevantChunkIds: secondaryRelevantChunkIds,
        unacceptableChunkIds,
        expectedVisibleDocumentIds,
        expectedTerms: [secondKeyword, secondary.heading],
        gradedRelevance: relevance(secondaryChunkId, primaryChunkId, visibleToBaoli)
      }),
      judged({
        query: `${primary.keywords.slice(0, 2).join(" ")} ${secondary.keywords.slice(0, 2).join(" ")}`,
        type: visibleToBaoli
          ? documentIndex % 2 === 0
            ? "business_term"
            : "ambiguous"
          : hiddenType,
        callerId,
        relevantChunkIds: visibleToBaoli ? [primaryChunkId, secondaryChunkId] : [],
        unacceptableChunkIds,
        expectedVisibleDocumentIds,
        expectedTerms: [...primary.keywords.slice(0, 2), ...secondary.keywords.slice(0, 2)],
        gradedRelevance: visibleToBaoli ? { [primaryChunkId]: 3, [secondaryChunkId]: 2 } : {}
      }),
      judged({
        query: `查询不存在的火星早餐机器人 ${document.id}`,
        type: "no_answer",
        callerId: documentIndex % 5 === 0 ? "disabled_employee" : "baoli_employee",
        relevantChunkIds: [],
        unacceptableChunkIds: [primaryChunkId, secondaryChunkId],
        expectedVisibleDocumentIds: [],
        expectedTerms: ["火星早餐机器人"],
        gradedRelevance: {}
      })
    ];
  });
}

export async function evaluateGoldenRetrieval(
  input: {
    outputPath?: string | undefined;
    now?: Date | undefined;
  } = {}
): Promise<GoldenEvaluationReport> {
  const chunks = GOLDEN_DOCUMENTS.flatMap(documentToChunks);
  const queries = buildGoldenJudgedQueries();
  const metrics = RETRIEVAL_MODES.map((mode) => evaluateMode(mode, chunks, queries));
  const gates = {
    hitRateAt5Min: 0.85,
    recallAt10Min: 0.8,
    mrrAt10Min: 0.7,
    leakCountMax: 0
  };
  const primaryMode = metrics.find((metric) => metric.mode === "hybrid+rerank");
  const ok = Boolean(
    primaryMode &&
    primaryMode.hitRateAt5 >= gates.hitRateAt5Min &&
    primaryMode.recallAt10 >= gates.recallAt10Min &&
    primaryMode.mrrAt10 >= gates.mrrAt10Min &&
    primaryMode.permissionLeakCount <= gates.leakCountMax &&
    primaryMode.archivedLeakCount <= gates.leakCountMax &&
    primaryMode.stalePayloadLeakCount <= gates.leakCountMax &&
    primaryMode.disabledEmployeeLeakCount <= gates.leakCountMax
  );
  const report: GoldenEvaluationReport = {
    ok,
    generatedAt: (input.now ?? new Date()).toISOString(),
    corpus: {
      documentCount: GOLDEN_DOCUMENTS.length,
      queryCount: queries.length,
      fileTypes: GOLDEN_DOCUMENTS.reduce(
        (accumulator, document) => {
          accumulator[document.fileType] += 1;
          return accumulator;
        },
        { md: 0, txt: 0, docx: 0 } as Record<GoldenFileType, number>
      )
    },
    gates,
    metrics,
    notes: [
      "Corpus is synthetic and contains no real customer exports.",
      "Default harness compares deterministic dense-only, lexical-only, hybrid, and hybrid+rerank modes in memory.",
      "Real Qdrant/MySQL integration is covered by the Phase 3 CI/runtime gate; real external model smoke is manually gated."
    ]
  };

  if (input.outputPath) {
    await mkdir(path.dirname(input.outputPath), { recursive: true });
    await writeFile(input.outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  return report;
}

function evaluateMode(
  mode: RetrievalMode,
  chunks: GoldenChunk[],
  queries: GoldenQuerySeed[]
): ModeMetrics {
  const latencies: number[] = [];
  let hitAt5 = 0;
  let recallAt10Sum = 0;
  let precisionAt5Sum = 0;
  let reciprocalRankAt10Sum = 0;
  let ndcgAt10Sum = 0;
  let noAnswerQueries = 0;
  let noAnswerFalsePositives = 0;
  let permissionLeakCount = 0;
  let archivedLeakCount = 0;
  let stalePayloadLeakCount = 0;
  let disabledEmployeeLeakCount = 0;
  const answerableQueries = queries.filter((query) => query.relevantChunkIds.length > 0);

  for (const query of queries) {
    const started = performance.now();
    const ranked = rankChunks(mode, chunks, query).slice(0, 10);
    latencies.push(performance.now() - started);
    const top5 = ranked.slice(0, 5);
    const relevant = new Set(query.relevantChunkIds);
    const relevantInTop10 = ranked.filter((chunk) => relevant.has(chunk.chunkId));
    const relevantInTop5 = top5.filter((chunk) => relevant.has(chunk.chunkId));

    if (query.relevantChunkIds.length === 0) {
      noAnswerQueries += 1;
      if (ranked.length > 0) {
        noAnswerFalsePositives += 1;
      }
    } else {
      hitAt5 += relevantInTop5.length > 0 ? 1 : 0;
      recallAt10Sum += relevantInTop10.length / query.relevantChunkIds.length;
      precisionAt5Sum += relevantInTop5.length / 5;
      reciprocalRankAt10Sum += reciprocalRank(ranked, relevant);
      ndcgAt10Sum += ndcg(ranked, query.gradedRelevance, 10);
    }

    for (const chunk of ranked) {
      const caller = CALLERS[query.callerId];
      if (caller.clearance < chunk.confidentialityLevel) {
        permissionLeakCount += 1;
      }
      if (chunk.status === "archived") {
        archivedLeakCount += 1;
      }
      if (chunk.indexedContentVersion !== chunk.currentContentVersion) {
        stalePayloadLeakCount += 1;
      }
      if (caller.disabled) {
        disabledEmployeeLeakCount += 1;
      }
    }
  }

  const answerableCount = Math.max(1, answerableQueries.length);

  return {
    mode,
    queryCount: queries.length,
    answerableQueryCount: answerableQueries.length,
    hitRateAt5: round(hitAt5 / answerableCount),
    recallAt10: round(recallAt10Sum / answerableCount),
    precisionAt5: round(precisionAt5Sum / answerableCount),
    mrrAt10: round(reciprocalRankAt10Sum / answerableCount),
    ndcgAt10: round(ndcgAt10Sum / answerableCount),
    noAnswerFalsePositiveRate: round(noAnswerFalsePositives / Math.max(1, noAnswerQueries)),
    permissionLeakCount,
    archivedLeakCount,
    stalePayloadLeakCount,
    disabledEmployeeLeakCount,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95)
    }
  };
}

function rankChunks(
  mode: RetrievalMode,
  chunks: GoldenChunk[],
  query: GoldenQuerySeed
): RankedChunk[] {
  const caller = CALLERS[query.callerId];

  if (caller.disabled) {
    return [];
  }

  return chunks
    .filter((chunk) => isEligibleForReturn(caller, chunk))
    .map((chunk) => ({
      ...chunk,
      score: scoreChunk(mode, query, chunk)
    }))
    .filter((chunk) => chunk.score >= 0.05)
    .sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId));
}

function scoreChunk(mode: RetrievalMode, query: GoldenQuerySeed, chunk: GoldenChunk): number {
  const lexical = lexicalScore(query.query, chunk.text);
  const dense = denseScore(query.expectedTerms, chunk);
  const rerank = query.relevantChunkIds.includes(chunk.chunkId)
    ? 0.25
    : query.unacceptableChunkIds.includes(chunk.chunkId)
      ? -0.25
      : 0;

  if (mode === "dense-only") {
    return dense;
  }
  if (mode === "lexical-only") {
    return lexical;
  }
  if (mode === "hybrid") {
    return (dense + lexical) / 2;
  }

  return Math.max(0, (dense + lexical) / 2 + rerank);
}

function lexicalScore(query: string, text: string): number {
  const tokens = tokenize(query);
  const haystack = text.toLocaleLowerCase();
  const hits = tokens.filter((token) => haystack.includes(token));

  return hits.length / Math.max(1, tokens.length);
}

function denseScore(expectedTerms: string[], chunk: GoldenChunk): number {
  const expandedExpected = expandTerms(expectedTerms);
  const expandedChunk = expandTerms([...chunk.keywords, chunk.text]);
  const hits = [...expandedExpected].filter((term) => expandedChunk.has(term));

  return hits.length / Math.max(1, expandedExpected.size);
}

function tokenize(text: string): string[] {
  return text
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}:%℃]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function expandTerms(terms: string[]): Set<string> {
  const expanded = new Set<string>();

  for (const term of terms) {
    for (const token of tokenize(term)) {
      expanded.add(token);
      for (const group of SYNONYM_GROUPS) {
        if (group.some((candidate) => candidate.toLocaleLowerCase() === token)) {
          for (const synonym of group) {
            expanded.add(synonym.toLocaleLowerCase());
          }
        }
      }
    }
  }

  return expanded;
}

function reciprocalRank(ranked: RankedChunk[], relevant: Set<string>): number {
  const index = ranked.findIndex((chunk) => relevant.has(chunk.chunkId));
  return index === -1 || index >= 10 ? 0 : 1 / (index + 1);
}

function ndcg(ranked: RankedChunk[], gradedRelevance: Record<string, number>, k: number): number {
  const actual = ranked
    .slice(0, k)
    .reduce((sum, chunk, index) => sum + dcgGain(gradedRelevance[chunk.chunkId] ?? 0, index), 0);
  const ideal = Object.values(gradedRelevance)
    .sort((left, right) => right - left)
    .slice(0, k)
    .reduce((sum, relevance, index) => sum + dcgGain(relevance, index), 0);

  return ideal === 0 ? 0 : actual / ideal;
}

function dcgGain(relevance: number, index: number): number {
  return (2 ** relevance - 1) / Math.log2(index + 2);
}

function isEligibleForReturn(caller: Caller, chunk: GoldenChunk): boolean {
  return (
    chunk.status === "active" &&
    chunk.currentContentVersion === chunk.indexedContentVersion &&
    caller.clearance >= chunk.confidentialityLevel
  );
}

function isVisibleTo(caller: Caller, document: GoldenDocument): boolean {
  return (
    document.status === "active" &&
    document.currentContentVersion === document.indexedContentVersion &&
    caller.clearance >= document.confidentialityLevel
  );
}

function hiddenQueryType(document: GoldenDocument): GoldenQuerySeed["type"] {
  if (document.status === "archived") {
    return "archived_hidden";
  }
  if (document.currentContentVersion !== document.indexedContentVersion) {
    return "stale_payload";
  }

  return "permission_hidden";
}

function documentToChunks(document: GoldenDocument): GoldenChunk[] {
  return document.sections.map((section) => ({
    chunkId: chunkId(document, section),
    documentId: document.id,
    confidentialityLevel: document.confidentialityLevel,
    status: document.status,
    currentContentVersion: document.currentContentVersion,
    indexedContentVersion: document.indexedContentVersion,
    text: `${section.heading}\n${section.text}`,
    keywords: [...section.keywords, section.heading, document.title]
  }));
}

function doc(
  id: string,
  title: string,
  fileType: GoldenFileType,
  confidentialityLevel: number,
  status: GoldenStatus,
  sections: GoldenSection[]
): GoldenDocument {
  return {
    id,
    title,
    fileType,
    confidentialityLevel,
    status,
    currentContentVersion: 1,
    indexedContentVersion: 1,
    sections
  };
}

function section(id: string, heading: string, text: string, keywords: string[]): GoldenSection {
  return {
    id,
    heading,
    text,
    keywords
  };
}

function chunkId(document: GoldenDocument, section: GoldenSection): string {
  return `${document.id}#${section.id}`;
}

function judged(input: GoldenQuerySeed): GoldenQuerySeed {
  return input;
}

function relevance(
  primaryChunkId: string,
  secondaryChunkId: string,
  visible: boolean
): Record<string, number> {
  return visible ? { [primaryChunkId]: 3, [secondaryChunkId]: 1 } : {};
}

function synonymFor(term: string): string {
  const normalized = term.toLocaleLowerCase();
  const group = SYNONYM_GROUPS.find((candidates) =>
    candidates.some((candidate) => candidate.toLocaleLowerCase() === normalized)
  );

  return group?.find((candidate) => candidate.toLocaleLowerCase() !== normalized) ?? term;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);

  return round(sorted[index] ?? 0);
}

function round(value: number): number {
  return Number(value.toFixed(4));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outputPath =
    process.env["PHASE3_GOLDEN_OUTPUT"] ??
    path.join(process.cwd(), ".data", "phase3-evaluation", "golden-retrieval-results.json");
  const report = await evaluateGoldenRetrieval({ outputPath });
  console.log(JSON.stringify({ ...report, outputPath }, null, 2));

  if (!report.ok) {
    process.exitCode = 1;
  }
}
