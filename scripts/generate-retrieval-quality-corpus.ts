/**
 * Generates the bulk of the retrieval-quality corpus.
 *
 * For every store and topic family it emits two near-duplicate document shapes — a full 规范 (SOP)
 * and a 检查表 (checklist) built from the same numbers — so the corpus contains hundreds of
 * mutually similar active documents. That similarity is what makes ranking matter; a corpus of
 * unrelated documents is easy for any retrieval strategy.
 *
 * Output:
 *   fixtures/retrieval-quality/generated/<family>-<store>-<shape>.md
 *   fixtures/retrieval-quality/generated-corpus.json
 *
 * Run: npx tsx scripts/generate-retrieval-quality-corpus.ts
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  FAMILIES,
  PARAM_QUERY_TEMPLATES,
  CODE_QUERY_TEMPLATES,
  MULTI_HOP_TEMPLATES,
  NO_ANSWER_QUERIES,
  ARCHIVED_MARKER,
  STALE_MARKER,
  STORE_PROFILES,
  storeValues,
  type FamilySpec,
  type StoreProfile
} from "./retrieval-corpus-spec.js";

interface GeneratedDocument {
  id: string;
  file: string;
  title: string;
  fileType: "md";
  labels: string[];
  status: "active";
}

interface GeneratedQuery {
  id: string;
  query: string;
  callerId: string;
  type: string;
  expectation: "answered" | "no_answer";
  expectedDocuments?: string[];
  expectedSections?: string[];
  forbiddenDocuments?: string[];
}

interface GeneratedManifest {
  version: string;
  generator: string;
  documents: GeneratedDocument[];
  callers: Array<{ id: string; employeeId: string; email: string; role: string; labels: string[] }>;
  queries: GeneratedQuery[];
}

const rootDir = process.cwd();
const corpusDir = path.join(rootDir, "fixtures", "retrieval-quality");
const generatedDir = path.join(corpusDir, "generated");

const VALUE_PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/**
 * Clause bank for the long "常见不符合项与整改要求" section. Real SOPs carry a long tail of these,
 * which is what pushes a single heading past the chunk size and creates multi-chunk sections.
 */
const NONCONFORMITY_CLAUSES: readonly string[] = [
  "记录类不符合项，包括记录缺项、笔迹不一致、集中补填多日记录或代签他人姓名，要求当日补齐规范填写并说明原因，由后厨主管在交接班时复核。",
  "记录时间与实际作业时间明显不符、撕毁或重抄原始记录的，属于严重不符合项，由店长直接处理并上报门店管理者，处理过程中应保留原始记录以便追溯。",
  "设备与工具类不符合项，包括设备超期未维护、工具混用、清洁工具堆放在地面或水池底部，能够当场整改的当场整改，无法当场整改的由店长确定责任人与完成时限。",
  "设备出现温度失控、异常声响或漏电迹象仍继续使用的，应立即停用并转移受影响食材，同时启动报修流程，受影响食材是否继续使用由店长判断并记录结论。",
  "温度控制类不符合项，包括温度记录缺失、超限未处置或记录与设备显示不一致，应立即复测并补记，必要时转移食材至备用设备。",
  "清洁消毒类不符合项，包括消毒液未进行浓度核验、作用时间不足、消毒后未冲净或清洁频次低于规定，必须当场重新执行清洁消毒流程。",
  "涉及食品接触面清洁消毒效果不符合项的，应对该时段内已加工的半成品与成品进行评估，不能确认安全的一律不得继续销售。",
  "虫害相关不符合项，包括发现鼠迹、蟑迹、活体虫害或防虫设施破损，要求当日联系专业服务方处理并完成区域性深度清洁与消毒。",
  "人员卫生类不符合项，包括未按岗位要求佩戴口罩、未更换工作服、带病坚持上岗或在食品处理区饮食吸烟，要求立即纠正并进行现场培训。",
  "同一员工在三个月内重复出现同类人员卫生问题的，由店长按门店管理要求处理并记录，必要时调整岗位安排。",
  "收货验收类不符合项，包括未查验温度记录、未核对标签信息或对明显异常原料未执行拒收，应追溯该批次去向并对相邻批次加严检查。",
  "供应商管理类不符合项，包括索证索票缺失、资质过期或评估记录未按期完成，应在规定时限内补齐并重新评估供应商等级。",
  "培训类不符合项，包括培训记录缺失、考核未达合格线仍安排独立上岗或新员工未完成入职培训，应重新组织培训与考核后再安排独立上岗。",
  "整改时限方面，能够当场完成的必须当场完成并标注当场整改；需要采购或维修的由店长确定完成日期，最长不超过门店规定期限，并在完成前采取临时控制措施。",
  "临时控制措施必须在整改完成后取消，取消前需确认设备或流程已恢复正常，实施与取消情况在门店管理例会上通报。",
  "门店应建立不符合项统计台账，按区域、按类别、按责任人汇总每月发生情况，连续两个月出现同类问题的由店长组织原因分析并调整作业安排。"
];

/** Additional generic clauses; together with the bank above these push the section past one chunk. */
const SUPPLEMENTARY_CLAUSES: readonly string[] = [
  "总部抽查中发现的不符合项，门店应在收到反馈后按反馈要求的时限完成整改，并将整改结果通过门店管理渠道反馈。",
  "整改反馈内容包括整改措施、完成时间、复检结论与防止再发生的措施，未按时反馈的由门店管理者跟进处理。",
  "复检不通过的不符合项，应升级处理并重新确定责任人与完成时限，必要时暂停相关区域作业直至风险消除。",
  "对同一区域连续出现的不符合项，应检查是否存在排班过紧、设备不足或培训缺失等系统性原因，而非仅处理单点问题。",
  "季节性风险应在相应时段前提前排查，包括夏季温度控制、雨季虫害防控与节假日高峰期的清洁频次保障。",
  "新设备或新流程投用前应完成风险确认与人员培训，并在投用首周增加检查频次，确认稳定后再恢复常态检查。",
  "涉及顾客投诉且可能影响其他顾客的不符合项，应暂停相关产品出品并保留样品与相关记录，由店长决定后续处置方式。",
  "门店应每季度复核一次不符合项清单是否仍然适用，法规或总部标准更新时应同步修订并组织培训。"
];

await rm(generatedDir, { recursive: true, force: true });
await mkdir(generatedDir, { recursive: true });

const documents: GeneratedDocument[] = [];
const queries: GeneratedQuery[] = [];
/** Ground truth needed to build cross-document comparison queries later. */
const paramIndex = new Map<string, Array<{ documentId: string; section: string; value: string }>>();

for (const family of FAMILIES) {
  for (const store of STORE_PROFILES) {
    const values = storeValues(store);
    const docCode = `SOP-${family.codePrefix}-${store.code}-2026`;
    const specDocId = `${family.id}-${store.code.toLowerCase()}-spec`;
    const checklistDocId = `${family.id}-${store.code.toLowerCase()}-checklist`;
    const specFile = `generated/${family.id}-${store.code.toLowerCase()}-spec.md`;
    const checklistFile = `generated/${family.id}-${store.code.toLowerCase()}-checklist.md`;
    const specTitle = `${store.store}店${family.title}`;
    const checklistTitle = `${store.store}店${family.title.replace("管理规范", "自查表").replace("出品标准", "出品自查表")}`;

    documents.push({
      id: specDocId,
      file: specFile,
      title: specTitle,
      fileType: "md",
      labels: ["all_staff"],
      status: "active"
    });
    documents.push({
      id: checklistDocId,
      file: checklistFile,
      title: checklistTitle,
      fileType: "md",
      labels: ["all_staff"],
      status: "active"
    });

    await writeFile(
      path.join(corpusDir, specFile),
      renderSpec(family, store, values, docCode, specTitle),
      "utf8"
    );
    await writeFile(
      path.join(corpusDir, checklistFile),
      renderChecklist(family, store, values, docCode, checklistTitle),
      "utf8"
    );

    const sectionByParam = new Map<number, string>();
    for (const section of family.sections) {
      for (const paramIndexValue of section.params ?? []) {
        sectionByParam.set(paramIndexValue, section.heading);
      }
    }

    family.params.forEach((paramName, index) => {
      const value = paramValue(family.id, index, values);
      const bucket = paramIndex.get(`${family.id}:${index}`) ?? [];
      bucket.push({ documentId: specDocId, section: sectionByParam.get(index) ?? "", value });
      paramIndex.set(`${family.id}:${index}`, bucket);
    });

    // Exact-code lookups only resolve through the lexical branch.
    queries.push({
      id: `code-${family.id}-${store.code.toLowerCase()}`,
      query: pick(CODE_QUERY_TEMPLATES, store.index),
      callerId: "all_staff_employee",
      type: "exact_keyword",
      expectation: "answered",
      expectedDocuments: [specDocId]
    });

    // Parameter lookups name the store and the rule but not the document.
    for (let index = 0; index < family.params.length; index += 2) {
      const section = sectionByParam.get(index);

      if (!section) {
        continue;
      }

      queries.push({
        id: `param-${family.id}-${store.code.toLowerCase()}-${index}`,
        query: fill(pick(PARAM_QUERY_TEMPLATES, store.index + index), {
          store: store.store,
          city: store.city,
          p: family.params[index] ?? ""
        }),
        callerId: "all_staff_employee",
        type: "chinese_synonym",
        expectation: "answered",
        expectedDocuments: [specDocId, checklistDocId],
        expectedSections: []
      });
    }
  }
}

// Cross-store comparisons: the two documents are near-identical, so this is where ranking matters.
for (const family of FAMILIES) {
  for (const [index, store] of STORE_PROFILES.entries()) {
    const other = STORE_PROFILES[(index + 3) % STORE_PROFILES.length];

    if (!other || other.index <= store.index) {
      continue;
    }

    queries.push({
      id: `compare-${family.id}-${store.code.toLowerCase()}-${other.code.toLowerCase()}`,
      query: fill(pick(MULTI_HOP_TEMPLATES, index), {
        a: store.store,
        b: other.store,
        p: family.params[0] ?? ""
      }),
      callerId: "admin",
      type: "multi_hop",
      expectation: "answered",
      expectedDocuments: [
        `${family.id}-${store.code.toLowerCase()}-spec`,
        `${family.id}-${other.code.toLowerCase()}-spec`
      ]
    });
  }
}

NO_ANSWER_QUERIES.forEach((query, index) => {
  queries.push({
    id: `no-answer-${index}`,
    query,
    callerId: "all_staff_employee",
    type: "no_answer",
    expectation: "no_answer"
  });
});

queries.push({
  id: "archived-marker-generated",
  query: ARCHIVED_MARKER,
  callerId: "all_staff_employee",
  type: "archived_hidden",
  expectation: "no_answer",
  forbiddenDocuments: ["archived-hygiene"]
});
queries.push({
  id: "stale-marker-generated",
  query: STALE_MARKER,
  callerId: "all_staff_employee",
  type: "stale_hidden",
  expectation: "no_answer",
  forbiddenDocuments: ["stale-fry"]
});

const manifest: GeneratedManifest = {
  version: "2026-09-12.v1",
  generator: "scripts/generate-retrieval-quality-corpus.ts",
  documents,
  callers: [
    {
      id: "all_staff_employee",
      employeeId: "emp_lijie",
      email: "lijie@example.com",
      role: "employee",
      labels: ["all_staff"]
    },
    {
      id: "admin",
      employeeId: "emp_admin",
      email: "admin@example.com",
      role: "admin",
      labels: ["all_staff"]
    }
  ],
  queries
};

await writeFile(
  path.join(corpusDir, "generated-corpus.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8"
);

console.log(
  JSON.stringify(
    {
      documents: documents.length,
      queries: queries.length,
      generatedDir,
      manifest: path.join(corpusDir, "generated-corpus.json")
    },
    null,
    2
  )
);

function renderSpec(
  family: FamilySpec,
  store: StoreProfile,
  values: Record<string, number>,
  docCode: string,
  title: string
): string {
  const lines = [
    `# ${title}（合成测试资料）`,
    "",
    "> 本文件为 SME_DATA_CENTER 检索质量评测的合成语料，内容为虚构示例，不代表任何真实企业标准或监管要求。",
    ">",
    `> 门店：${store.store}店（${store.city}）；门店代号：${store.code}；文件编号：${docCode}；版本：${store.revisionYear}`,
    ""
  ];

  for (const section of family.sections) {
    lines.push(`## ${section.heading}`, "");

    for (const paragraph of section.paragraphs) {
      lines.push(render(paragraph, family, store, values, docCode), "");
    }
  }

  lines.push(`## ${family.sections.length + 1} 常见不符合项与整改要求`, "");

  const parameterClauses = family.params.map(
    (paramName, index) =>
      `涉及${paramName}的要求未按本规范执行，包括记录缺失、数值超出允许范围或未按期核验的，应立即复测并按 ${paramValue(
        family.id,
        index,
        values
      )} 的标准重新执行，同时由后厨主管在当班记录中补充说明并复核签字。`
  );

  for (const clause of [...NONCONFORMITY_CLAUSES, ...parameterClauses, ...SUPPLEMENTARY_CLAUSES]) {
    lines.push(render(clause, family, store, values, docCode), "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderChecklist(
  family: FamilySpec,
  store: StoreProfile,
  values: Record<string, number>,
  docCode: string,
  title: string
): string {
  const rows = family.params
    .map((paramName, index) => {
      const section = family.sections.find((candidate) => (candidate.params ?? []).includes(index));

      return `| ${index + 1} | ${paramName} | ${paramValue(family.id, index, values)} | ${ownerFor(
        index
      )} | ${section?.heading.replace(/^\d+\s*/, "") ?? "见规范"} |`;
    })
    .join("\n");

  const lines = [
    `# ${title}（合成测试资料）`,
    "",
    "> 本文件为 SME_DATA_CENTER 检索质量评测的合成语料，内容为虚构示例，不代表任何真实企业标准或监管要求。",
    ">",
    `> 门店：${store.store}店（${store.city}）；门店代号：${store.code}；文件编号：${docCode}；版本：${store.revisionYear}`,
    "",
    "## 使用说明",
    "",
    `${store.store}店后厨主管在每月自查时使用本表，逐项核对并记录结论。发现不符合项的，按当场整改、限期整改、上报处理三档处理；涉及食品安全风险的必须当场整改并复检。本表与《${store.store}店${family.title}》配套使用，两者不一致时以规范正文为准。`,
    "",
    "## 自查条目",
    "",
    "| 序号 | 检查项目 | 判定标准 | 责任人 | 依据章节 |",
    "| --- | --- | --- | --- | --- |",
    rows,
    "",
    "## 复核要求",
    "",
    `自查结果由后厨主管汇总，店长复核签字后归档，保存期限不少于 ${
      values["recordYears"] ?? 2
    } 年。连续两个月出现同类不符合项的区域，由店长组织专项复核并调整作业分工。`,
    "",
    `本表编号 ${docCode}，与规范正文同步修订。`
  ];

  return `${lines.join("\n").trimEnd()}\n`;
}

function render(
  paragraph: string,
  family: FamilySpec,
  store: StoreProfile,
  values: Record<string, number>,
  docCode: string
): string {
  return fill(paragraph, {
    store: store.store,
    city: store.city,
    code: store.code,
    doc: docCode,
    ...values
  });
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(VALUE_PLACEHOLDER, (match, key: string) =>
    key in values ? String(values[key]) : match
  );
}

function paramValue(familyId: string, index: number, values: Record<string, number>): string {
  const read = (key: string) => values[key] ?? 0;

  switch (familyId) {
    case "cold-chain":
      return (
        [
          `${read("coldLow")} 至 ${read("coldHigh")} 摄氏度`,
          `零下 ${read("frozenMax")} 摄氏度`,
          `每 ${read("logIntervalHours")} 小时`,
          `${read("receivingMaxTemp")} 摄氏度`,
          `${read("thawHours")} 小时`,
          `每 ${read("calibrationDays")} 天`
        ][index] ?? ""
      );
    case "hygiene":
      return (
        [
          `每 ${read("defrostDays")} 天`,
          `每 ${read("hoodFilterDays")} 天`,
          `每 ${read("ductMonths")} 个月`,
          `不少于 ${read("sanitizerMinutes")} 分钟`,
          `${read("pestResponseHours")} 小时`,
          "每班一次"
        ][index] ?? ""
      );
    case "fry":
      return (
        [
          `${read("fryTemperature")} 摄氏度`,
          `${read("refryTemperature")} 摄氏度`,
          `${read("chickenMinutes")} 分 ${read("chickenSeconds")} 秒`,
          `每 ${read("oilChangeDays")} 天`,
          `${read("holdingMinutes")} 分钟`,
          `${read("displayTemp")} 摄氏度`
        ][index] ?? ""
      );
    case "staff":
      return (
        [
          `提前 ${read("healthCheckMonths")} 个月`,
          `${read("healthCheckMonths")} 类`,
          `每年 ${read("trainingPerYear")} 次`,
          `${read("passingScore")} 分`,
          `${read("recordYears")} 年`,
          `${read("sealCheckWeeks")} 周`
        ][index] ?? ""
      );
    case "receiving":
      return (
        [
          `${read("receivingMinutes")} 分钟`,
          `${read("receivingMaxTemp")} 摄氏度`,
          `${read("rejectionChecks")} 类`,
          `${read("recordYears")} 年`,
          `每 ${read("supplierReviewMonths")} 个月`,
          `${read("returnDays")} 天`
        ][index] ?? ""
      );
    case "equipment":
      return (
        [
          `每 ${read("defrostDays")} 天`,
          `每 ${read("sealCheckWeeks")} 周`,
          `每 ${read("flyLampWeeks")} 周`,
          `${read("repairHours")} 小时`,
          "按门店备用设备清单执行",
          `${read("recordYears")} 年`
        ][index] ?? ""
      );
    default:
      return "";
  }
}

function ownerFor(index: number): string {
  return ["后厨主管", "库管员", "值班员工", "店长"][index % 4] ?? "后厨主管";
}

function pick<T>(items: readonly T[], index: number): T {
  return items[index % items.length] as T;
}
