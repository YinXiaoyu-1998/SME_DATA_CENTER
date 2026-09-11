/**
 * Authoring data for the retrieval-quality corpus generator.
 *
 * The corpus imitates how a real restaurant chain documents operations: shared head-office clauses
 * that every store repeats almost verbatim, plus per-store numbers, store codes, and revision
 * years. That similarity is the point — it is what makes retrieval hard in production, because a
 * query about "冷藏温度" matches every store's document almost equally well.
 *
 * All text here is authored for this repository. No third-party document is copied.
 */

export interface StoreProfile {
  store: string;
  code: string;
  city: string;
  /** 0-based position, used to vary numeric values deterministically. */
  index: number;
  revisionYear: number;
}

export interface FamilySpec {
  id: string;
  codePrefix: string;
  title: string;
  /** Parameter names shown to query generation, ordered to match the placeholders p1..p6. */
  params: readonly [string, string, string, string, string, string];
  sections: readonly SectionSpec[];
}

export interface SectionSpec {
  heading: string;
  /** Parameter indices (0-based) that this section answers, used for query ground truth. */
  params?: readonly number[];
  paragraphs: readonly string[];
}

export const STORE_PROFILES: readonly StoreProfile[] = [
  { store: "保利", code: "BL", city: "广州", index: 0, revisionYear: 2026 },
  { store: "苏州", code: "SZ", city: "苏州", index: 1, revisionYear: 2026 },
  { store: "望京", code: "WJ", city: "北京", index: 2, revisionYear: 2026 },
  { store: "天河", code: "TH", city: "广州", index: 3, revisionYear: 2026 },
  { store: "江北", code: "JB", city: "南京", index: 4, revisionYear: 2026 },
  { store: "西湖", code: "XH", city: "杭州", index: 5, revisionYear: 2026 },
  { store: "锦江", code: "JJ", city: "成都", index: 6, revisionYear: 2026 },
  { store: "南山", code: "NS", city: "深圳", index: 7, revisionYear: 2026 }
] as const;

/**
 * Numeric character of each store. Values are deliberately close to each other so that only exact
 * matching distinguishes one store's rule from another's.
 */
export function storeValues(store: StoreProfile) {
  const i = store.index;

  return {
    coldLow: 0 + (i % 3),
    coldHigh: 4 + (i % 3),
    frozenMax: 18 + (i % 3) * 2,
    logIntervalHours: 2 + (i % 3),
    receivingMaxTemp: 4 + (i % 4),
    thawHours: 12 + (i % 4) * 6,
    calibrationDays: 7 + (i % 3) * 7,
    hoodFilterDays: 2 + (i % 4),
    ductMonths: 2 + (i % 3),
    sanitizerMinutes: 5 + (i % 4),
    pestResponseHours: 12 + (i % 3) * 12,
    fryTemperature: 165 + (i % 5) * 5,
    refryTemperature: 185 + (i % 4) * 5,
    chickenMinutes: 4 + (i % 3),
    chickenSeconds: (i % 4) * 15,
    oilChangeDays: 2 + (i % 4),
    holdingMinutes: 10 + (i % 4) * 5,
    displayTemp: 60 + (i % 3) * 5,
    healthCheckMonths: 10 + (i % 3),
    trainingPerYear: 3 + (i % 3),
    passingScore: 80 + (i % 4) * 5,
    receivingMinutes: 30 + (i % 4) * 10,
    rejectionChecks: 5 + (i % 3),
    recordYears: 2 + (i % 3),
    supplierReviewMonths: 6 + (i % 3) * 3,
    returnDays: 2 + (i % 3),
    defrostDays: 7 + (i % 3) * 7,
    sealCheckWeeks: 2 + (i % 3),
    flyLampWeeks: 1 + (i % 3),
    repairHours: 4 + (i % 4) * 4
  };
}

export const FAMILIES: readonly FamilySpec[] = [
  {
    id: "cold-chain",
    codePrefix: "CC",
    title: "冷链与温度控制管理规范",
    params: [
      "冷藏库温度区间",
      "冷冻库温度上限",
      "温度记录间隔",
      "冷链到货中心温度上限",
      "解冻后存放时限",
      "设备温度计校验频次"
    ],
    sections: [
      {
        heading: "1 适用范围与责任划分",
        paragraphs: [
          "本规范适用于{store}店（门店代号 {code}）的冷藏库、冷冻库、冷藏展示柜、冷冻展示柜与冷链收货暂存区。门店店长为温度控制第一责任人，库管员负责温度记录与库存轮换，后厨主管负责每班复核。",
          "责任划分遵循“谁存放、谁记录、谁复核”的原则。库管员在每班交接时核对温度记录与库存状态，后厨主管在交接班记录上签字确认，店长每周抽查一次记录完整性与异常处置结果。",
          "本规范由总部食品安全部门制定并随文件版本更新。门店不得自行修改温度限值与记录频次；确有设备条件差异的，需报总部评估后以门店补充说明的形式发布。"
        ]
      },
      {
        heading: "2 温度控制范围",
        params: [0, 1, 2],
        paragraphs: [
          "冷藏库温度应保持在 {coldLow} 至 {coldHigh} 摄氏度之间，冷冻库温度应保持在零下 {frozenMax} 摄氏度以下。冷藏与冷冻设备应配备可正常读数的温度显示装置，显示装置损坏或读数明显异常时应立即报修并启用备用温度计。",
          "温度记录间隔为每 {logIntervalHours} 小时一次，记录内容包括时间、温度、设备编号与记录人。记录出现缺项、笔迹不一致或明显追记的，按记录不真实处理。",
          "熟制半成品在冷却过程中应尽快通过危险温度带，冷却完成后的存放温度不得超过 {coldHigh} 摄氏度。已解冻的原料不得再次冷冻，当班未使用完的解冻原料应按门店规定的处置方式处理。",
          "热食保温温度不得低于 60 摄氏度，冷食展示温度不得高于 {coldHigh} 摄氏度。保温与冷藏展示设备的温度应至少每 {logIntervalHours} 小时记录一次。"
        ]
      },
      {
        heading: "3 收货与验收",
        params: [3],
        paragraphs: [
          "冷链原料到货时，收货人应在卸货前查看运输车辆温度记录与产品包装状态。冷藏产品中心温度不得高于 {receivingMaxTemp} 摄氏度，冷冻产品不得出现明显解冻痕迹、冰晶异常或包装鼓包。",
          "发现温度超标、包装破损、标签信息缺失或产品感官异常时，应拒收并在收货单上注明原因。验收应在原料离开冷链后 {receivingMinutes} 分钟内完成，需要分次验收的，未验收部分应保持在适宜温度条件下存放。",
          "验收完成后立即入库并登记入库时间、批次与保质期，做到先进先出。{store}店的验收记录由库管员填写，后厨主管复核。"
        ]
      },
      {
        heading: "4 存储与分区分架",
        paragraphs: [
          "冷藏与冷冻库内应按照原料、半成品、成品分区存放，生鲜畜禽与水产品分层存放，避免汁液交叉滴落。所有食材必须离地离墙存放并加盖或覆膜，禁止裸放。",
          "拆包后的原料应使用密闭容器盛装并标注拆包日期。库存应执行先进先出，临近保质期的原料优先使用。门店应每周至少检查一次库存，清除过期、变质或标签信息缺失的原料。",
          "发现包装渗漏或汁液外溢时，应立即清理受影响区域并对相邻食材进行状态确认，处理过程记录在当班记录表上。"
        ]
      },
      {
        heading: "5 解冻与再加工",
        params: [4],
        paragraphs: [
          "解冻应在冷藏条件下进行，或使用流动水解冻并在 {thawHours} 小时内完成加工。禁止在室温条件下长时间解冻，禁止使用热水直接冲淋解冻。",
          "解冻后的原料应在 {thawHours} 小时内使用完毕，超过时限的不得继续使用，按报废流程处理并记录。解冻过程中产生的汁液应集中收集，不得污染其他食材或操作台面。",
          "同一批次解冻量应与当日预计用量匹配，避免反复解冻与冷藏。"
        ]
      },
      {
        heading: "6 设备校验与维护",
        params: [5],
        paragraphs: [
          "冷藏与冷冻设备的温度计应每 {calibrationDays} 天使用冰水混合物法校验一次，校验结果记录在设备校验表中。校验偏差超过 1 摄氏度时应更换温度计并追溯该时段的温度记录。",
          "设备应定期除霜，除霜时不得使用尖锐器具铲刮内壁。设备密封条、排水孔与冷凝器散热片应保持清洁，密封条出现破损或闭合不严时立即报修。",
          "{store}店的设备校验与维护记录由库管员保管，后厨主管每月复核一次。"
        ]
      },
      {
        heading: "7 停电与故障处置",
        paragraphs: [
          "停电或设备故障期间，门店应保持设备门体关闭，减少温度波动，转移食材时使用保温箱并记录转移时间与温度。",
          "恢复供电后应确认设备温度稳定在允差范围内，再恢复常态存放。受影响食材是否继续使用，由店长根据温度记录与暴露时间判断并记录结论，无法确认安全的一律不得继续销售。",
          "设备故障应立即联系维修并登记故障时间、恢复时间与处理方式，同一设备在一个月内重复故障的应上报总部评估更换。"
        ]
      },
      {
        heading: "8 记录与追溯",
        paragraphs: [
          "温度记录表按设备分别填写，每日汇总一次，由后厨主管复核签字。记录出现异常值时应同时记录采取的措施与处理结果，不得只在数值旁标注符号而无说明。",
          "发生食材退货、报废或异常处置时，应保留对应批次的进货凭证、验收记录与处置记录，确保能够追溯到具体批次与处置时间。追溯资料由店长归档，保存期限不少于 {recordYears} 年。",
          "{store}店的追溯资料在总部抽查时应能够当场调取。"
        ]
      }
    ]
  },
  {
    id: "hygiene",
    codePrefix: "HY",
    title: "后厨卫生与清洁消毒规范",
    params: [
      "冷藏设备内部擦拭频次",
      "油烟罩滤网清洗间隔",
      "排烟管道清洗周期",
      "餐具化学消毒浸泡时长",
      "虫害迹象上报处理时限",
      "消毒液浓度核验频次"
    ],
    sections: [
      {
        heading: "1 适用范围与责任划分",
        paragraphs: [
          "本规范适用于{store}店（门店代号 {code}）的后厨加工区、洗碗间、冷库、垃圾暂存区与员工通道。后厨主管负责排班与抽查，值班员工负责本岗位区域的即时清洁。",
          "清洁作业分为随时清洁、每班清洁、每日收档清洁与每周深度清洁四类。随时清洁指操作过程中产生的即时污渍处理，必须在污渍产生后 10 分钟内完成。",
          "本规范由总部食品安全部门制定，门店不得自行降低清洁频次；设备条件或营业时段确有差异的，需报总部评估后发布门店补充说明。"
        ]
      },
      {
        heading: "2 清洁频次与作业标准",
        params: [0],
        paragraphs: [
          "地面清洁使用符合要求的清洁剂稀释后拖洗，油污较重区域先刮除再拖洗，禁止直接用水冲洗电气设备周边。排水沟每班清理滤网残渣，每日收档使用热水与去油清洁剂刷洗沟体。",
          "冷藏设备内部每 {defrostDays} 天擦拭一次，冷冻设备内部每 {defrostDays} 天擦拭一次。设备内食材必须离地离墙存放并加盖或覆膜，生熟分层明确。",
          "操作台在每批次加工前后各清洁一次，加工生鲜畜禽肉类的台面在清洁后进行消毒。砧板按颜色分区使用，生熟分开，使用后先刮除残渣，再用清洁剂刷洗、清水冲净、消毒液浸泡或喷洒，最后立放沥干。",
          "砧板出现深裂纹、变形或难以清洁的划痕时必须报废更换，不得继续使用。"
        ]
      },
      {
        heading: "3 灶台油烟罩与排烟管道",
        params: [1, 2],
        paragraphs: [
          "灶台台面每班清洁，灶眼周边油垢使用专用去油剂处理后擦净。油烟罩滤网每 {hoodFilterDays} 天至少清洗一次，油杯在油位达到三分之二时即时倾倒，不得溢出。",
          "排烟管道由门店委托的第三方每 {ductMonths} 个月至少清洗一次，清洗后留存影像与清洗记录，店长核对后归档。{store}店的管道清洗记录在总部抽查时应能够当场调取。",
          "清洗作业应在非营业时段进行，作业完成后确认设备无异味、无滴油后方可恢复使用。"
        ]
      },
      {
        heading: "4 洗碗间与餐具消毒",
        params: [3],
        paragraphs: [
          "餐具清洗遵循“一刮、二洗、三冲、四消毒、五保洁”的流程。消毒优先采用热力消毒，消毒柜内温度与时间按设备说明执行。",
          "使用化学消毒时，消毒液浓度按说明书配制并使用试纸核验，浸泡时间不少于 {sanitizerMinutes} 分钟。消毒后的餐具存放在专用保洁柜内，柜内不得存放个人物品或清洁工具。",
          "消毒液应现配现用，超过有效期的必须废弃并重新配制。当日配制量应与当日用量匹配，不得大量囤积。"
        ]
      },
      {
        heading: "5 清洁剂与消毒剂管理",
        params: [5],
        paragraphs: [
          "清洁剂与消毒剂由店长指定的专人保管，专柜上锁，不得与食品、食品原料、包装材料或直接接触食品的工具混放。领取时登记名称、数量、领取人。",
          "原液分装必须使用专用容器并粘贴标签，标签至少包含品名、浓度、配制日期与配制人。禁止使用无标签容器盛装清洁剂。配制消毒液时必须使用量具，不得目测估算。",
          "消毒液浓度每班核验一次，使用浓度试纸或余氯测试纸判读并记录。核验结果低于下限的必须重新配制，高于上限的必须按说明稀释至允许范围后再使用。"
        ]
      },
      {
        heading: "6 虫害控制",
        params: [4],
        paragraphs: [
          "门店应保持门窗、风幕机、纱窗及下水篦子完好，发现破损应在当日报修。垃圾必须使用带盖容器存放并做到日产日清，垃圾暂存区地面每日冲洗。",
          "粘鼠板、灭蝇灯等设施的点位由店长统一确定，数量与位置不得随意变动。灭蝇灯每周至少清洁一次，粘捕式设施在粘满或达到说明更换条件时立即更换。",
          "员工在作业过程中发现鼠迹、蟑迹或活体虫害时，应立即上报店长，门店应在 {pestResponseHours} 小时内联系专业服务方处理，并在处理完成后进行区域性深度清洁与消毒。"
        ]
      },
      {
        heading: "7 员工卫生要求",
        paragraphs: [
          "员工进入后厨前必须更换工作服、工作帽，并按照要求洗手消毒。接触直接入口食品的岗位必须佩戴口罩。",
          "手部有伤口时必须使用颜色醒目的防水创可贴并加戴一次性手套，伤口位于明显影响操作的位置时不得从事接触直接入口食品的工作。",
          "员工出现发热、腹泻、呕吐、皮肤化脓性或者渗出性病症时，应立即停止接触直接入口食品的工作并报告店长。"
        ]
      },
      {
        heading: "8 记录与复核",
        paragraphs: [
          "清洁记录表由当班员工填写，后厨主管在交接班时复核签字，店长每周复核一次。记录内容包括清洁时间、区域、执行人、使用的清洁剂或消毒剂、异常情况与处理方式。",
          "记录不得追记或补记，发现记录不实按门店管理要求处理。{store}店的清洁记录保存期限不少于 {recordYears} 年。"
        ]
      }
    ]
  },
  {
    id: "fry",
    codePrefix: "FR",
    title: "油炸类产品出品标准",
    params: [
      "下锅油温",
      "复炸油温",
      "鸡肉类产品炸制时长",
      "炸锅用油更换周期",
      "产品最长存放时间",
      "展示保温温度下限"
    ],
    sections: [
      {
        heading: "1 适用范围与设备清单",
        paragraphs: [
          "本规范适用于{store}店（门店代号 {code}）所有油炸类产品的出品与设备管理，覆盖单缸炸炉、双缸炸炉、滤油车、保温展示柜与油温计。",
          "油炸类产品的出品由烹饪岗位负责，油温与用油状态由后厨主管每班检查一次。本规范与总部出品标准冲突时，以本规范为准。"
        ]
      },
      {
        heading: "2 油温与炸制时间",
        params: [0, 1, 2, 5],
        paragraphs: [
          "{store}店油炸类产品的下锅油温统一控制在 {fryTemperature} 摄氏度，复炸油温控制在 {refryTemperature} 摄氏度。鸡肉类产品单次炸制时间为 {chickenMinutes} 分 {chickenSeconds} 秒，薯类产品按总部标准执行。",
          "油温计每班开工前校准一次，校准方式为冰水混合物法，校准结果记录在当班记录表上。油温偏离设定值超过 5 摄氏度时，应调整火力并等待温度回稳后再下锅，不得在温度未回稳时连续投料。",
          "展示保温设备的温度不得低于 {displayTemp} 摄氏度，每两小时记录一次温度。"
        ]
      },
      {
        heading: "3 用油管理与更换周期",
        params: [3],
        paragraphs: [
          "炸锅用油每 {oilChangeDays} 天更换一次，出现颜色明显加深、连续起泡、油烟明显增大或出现异味时应提前更换。每日收档后过滤油渣，滤网不得重复使用超过一个班次。",
          "废油由门店统一收集在带盖容器中，交由具备资质的回收方处理并留存交接记录。废油容器不得与食材或餐具存放于同一区域。"
        ]
      },
      {
        heading: "4 出品与存放",
        params: [4],
        paragraphs: [
          "炸制完成的产品应在 5 分钟内交付。超过 {holdingMinutes} 分钟未售出的产品不得继续销售，应报废并记录。门店不得通过复炸延长已超时产品的销售时间。",
          "产品出餐前应检查外观，出现焦黑、回软、明显脱粉或油脂渗出的不予出餐。",
          "报废产品应在报废记录中登记品名、数量、时间与原因，由后厨主管复核签字。"
        ]
      },
      {
        heading: "5 器具清洁",
        paragraphs: [
          "炸篮、滤油架与操作台每班清洁一次。炸锅每 {oilChangeDays} 天至少进行一次彻底清洁，包括锅体、加热管与底部沉积物。",
          "清洁后应确认无清洁剂残留，再进行下一次使用。清洁工具按用途分区存放，不得与其他区域混用。"
        ]
      },
      {
        heading: "6 品质判定与报废",
        paragraphs: [
          "门店应建立油炸类产品的品质判定标准，明确焦黑、回软、脱粉、渗油等外观不合格情形的处理方式。判定由出餐岗位执行，后厨主管复核。",
          "同一批次产品连续出现三次以上不合格时，应暂停该产品出品，排查油温、油质、投料量与设备状态，确认原因后方可恢复。"
        ]
      },
      {
        heading: "7 交接与记录",
        paragraphs: [
          "油温记录、换油记录、滤油记录与报废记录由当班员工填写，后厨主管在交接班时复核签字。记录内容包括时间、数值、执行人与异常处置方式。",
          "{store}店的油炸类记录保存期限不少于 {recordYears} 年，总部抽查时应能够当场调取。"
        ]
      }
    ]
  },
  {
    id: "staff",
    codePrefix: "ST",
    title: "员工健康与食品安全培训管理规范",
    params: [
      "健康证明复检提醒提前量",
      "班前健康观察项目数",
      "培训频次",
      "考核合格线",
      "培训记录保存期",
      "新员工独立上岗等待期"
    ],
    sections: [
      {
        heading: "1 健康证明与入职要求",
        params: [0, 5],
        paragraphs: [
          "从事接触直接入口食品工作的员工在上岗前必须取得有效的健康证明，健康证明由门店统一归档并在到期前 {healthCheckMonths} 个月提醒复检。",
          "健康证明缺失、过期或无法提供原件的员工，不得从事接触直接入口食品的工作。新员工应在新员工独立上岗等待期届满并通过考核后，方可独立上岗。",
          "门店应建立员工健康档案，记录健康证明有效期、培训记录与岗位调整情况。{store}店的健康档案由店长负责维护。"
        ]
      },
      {
        heading: "2 每日健康观察",
        params: [1],
        paragraphs: [
          "班前会由后厨主管对当班员工进行健康观察，观察内容涵盖发热、咳嗽、咽痛、腹泻、呕吐、皮肤伤口与化脓性病症等 {healthCheckMonths} 类情形。员工本人也应主动报告身体不适情况，不得隐瞒。",
          "出现发热、腹泻、呕吐或皮肤化脓性、渗出性病症的员工，应立即停止接触直接入口食品的工作并报告店长。症状消失后，员工应提供必要的就诊或恢复说明，经店长确认后方可返岗。",
          "返岗首日由后厨主管重点观察并在班前会记录中登记。"
        ]
      },
      {
        heading: "3 手部卫生与防护",
        paragraphs: [
          "员工在进入后厨前、接触食品前、处理生鲜畜禽与水产品后、使用洗手间后、接触垃圾或清洁工具后、咳嗽打喷嚏或触摸面部后，必须洗手并进行手部消毒。",
          "洗手应使用洗手液与流动清水，搓洗时间足够，随后使用一次性纸巾或干手设备干燥。手部有伤口的员工必须使用颜色醒目的防水创可贴覆盖，并加戴一次性手套。",
          "伤口位于明显影响操作或难以有效覆盖的位置时，不得从事接触直接入口食品的工作，由后厨主管调整岗位安排。"
        ]
      },
      {
        heading: "4 工作服与个人物品管理",
        paragraphs: [
          "员工进入后厨前必须更换工作服与工作帽，工作服应保持清洁并按规定频次更换。接触直接入口食品的岗位必须佩戴口罩。",
          "工作服不得穿出后厨区域，不得与个人衣物混放。个人物品、水杯与手机应存放在指定区域，不得带入食品加工区。",
          "员工不得在食品处理区内饮食、吸烟或从事其他可能污染食品的行为。"
        ]
      },
      {
        heading: "5 培训计划与考核",
        params: [2, 3],
        paragraphs: [
          "门店应制定年度培训计划，覆盖食品安全基础知识、清洁消毒、温度控制、虫害识别、异常上报与应急处置。培训频次不低于每年 {trainingPerYear} 次，新员工入职培训与在岗员工复训分别记录。",
          "每次培训应留存记录，内容包括培训日期、主题、讲师、参训人员签到、培训方式与考核结果。考核合格线为 {passingScore} 分，未通过的应重新培训并再次考核。",
          "培训内容发生更新时，应在下次培训中覆盖变更部分并说明生效时间。"
        ]
      },
      {
        heading: "6 培训记录与归档",
        params: [4],
        paragraphs: [
          "培训记录由店长归档，保存期限不少于 {recordYears} 年，总部抽查时应能够当场提供。{store}店的培训记录应能够追溯到具体员工与具体场次。",
          "员工岗位发生调整时，应确认新岗位所需的培训已完成并在记录中更新。"
        ]
      },
      {
        heading: "7 异常上报与返岗管理",
        paragraphs: [
          "员工健康异常由后厨主管当班上报店长，涉及顾客投诉或可能影响其他顾客的，应同时保留相关记录。",
          "返岗员工在返岗后一周内出现同类症状的，应由店长重新评估岗位安排并记录结论。"
        ]
      }
    ]
  },
  {
    id: "receiving",
    codePrefix: "RC",
    title: "收货验收与供应商管理规范",
    params: [
      "冷链到货验收时限",
      "到货温度上限",
      "拒收判定项数",
      "索证索票保存期",
      "供应商评级周期",
      "退货登记时限"
    ],
    sections: [
      {
        heading: "1 适用范围与责任划分",
        paragraphs: [
          "本规范适用于{store}店（门店代号 {code}）所有原料、包装材料与清洁用品的收货验收与供应商管理。收货由库管员执行，后厨主管复核，店长对供应商评估结论负责。",
          "收货区域应保持清洁并具备必要的温度控制条件，验收过程不得造成原料污染或温度失控。"
        ]
      },
      {
        heading: "2 收货与验收时限",
        params: [0, 1],
        paragraphs: [
          "冷链原料到货时，收货人应在卸货前查看运输车辆温度记录与产品包装状态，验收应在原料离开冷链后 {receivingMinutes} 分钟内完成。",
          "冷藏产品中心温度不得高于 {receivingMaxTemp} 摄氏度，冷冻产品不得出现明显解冻痕迹、冰晶异常或包装鼓包。{store}店的到货温度上限在总部统一标准基础上不做放宽。",
          "需要分次验收的，未验收部分应保持在适宜温度条件下存放，并在验收完成后立即入库登记。"
        ]
      },
      {
        heading: "3 拒收判定标准",
        params: [2],
        paragraphs: [
          "出现以下情形之一应拒收：温度超标、包装破损或渗漏、标签信息缺失或与订单不符、产品感官异常、超过保质期或临近保质期不足规定天数、无有效检疫或合格证明，以及索证索票无法提供。{store}店的拒收判定项按上述 {rejectionChecks} 类执行。",
          "拒收应在收货单上注明原因并由送货人签字确认，同时拍照留存。拒收记录当日上报店长。",
          "同一供应商一个月内累计三次拒收的，应上报总部评估供应商资格。"
        ]
      },
      {
        heading: "4 索证索票与资质留存",
        params: [3],
        paragraphs: [
          "门店应留存供应商营业执照、食品经营许可证、产品合格证明与检疫证明等材料的复印件或电子件，并确保在有效期内。",
          "进货票据应记录品名、规格、数量、生产日期或批号、供货方与到货时间。索证索票与进货票据保存期限不少于 {recordYears} 年。"
        ]
      },
      {
        heading: "5 供应商评估与分级",
        params: [4],
        paragraphs: [
          "门店应每 {supplierReviewMonths} 个月对主要供应商进行一次评估，评估内容包括到货合格率、拒收次数、交付及时性与异常处置配合度。",
          "评估结果分为合格、观察与不合格三档。观察档供应商应增加抽检频次并书面反馈改进要求；不合格档供应商应暂停合作并上报总部。"
        ]
      },
      {
        heading: "6 退货与索赔",
        params: [5],
        paragraphs: [
          "需要退货的批次应在 {returnDays} 天内完成登记与退回，登记内容包括品名、批次、数量、退货原因与处理结果。",
          "退货涉及的运输与存储条件应符合原料保存要求，不得在常温下长时间滞留。"
        ]
      },
      {
        heading: "7 记录与追溯",
        paragraphs: [
          "收货记录、拒收记录、供应商评估记录与退货记录由库管员填写，后厨主管复核，店长每月汇总一次。",
          "发生食品安全异常需要追溯时，门店应能够通过批次信息追溯到供应商、到货时间与验收记录。"
        ]
      }
    ]
  },
  {
    id: "equipment",
    codePrefix: "EQ",
    title: "设备维护与虫害控制规范",
    params: [
      "冷藏设备除霜周期",
      "密封条检查频次",
      "灭蝇灯清洁频次",
      "维修响应时限",
      "备用设备配置要求",
      "设备维护记录保存期"
    ],
    sections: [
      {
        heading: "1 适用范围与责任划分",
        paragraphs: [
          "本规范适用于{store}店（门店代号 {code}）的冷藏冷冻设备、加热与保温设备、虫害控制设施及其相关记录管理。设备维护由库管员与后厨主管分工负责，店长负总责。",
          "门店应建立设备台账，记录设备名称、编号、投用时间、维护历史与当前状态。"
        ]
      },
      {
        heading: "2 冷藏冷冻设备维护",
        params: [0, 1],
        paragraphs: [
          "冷藏与冷冻设备内部每 {defrostDays} 天除霜一次，除霜时不得使用尖锐器具铲刮内壁。设备排水孔应保持通畅，冷凝器散热片每季度清洁一次。",
          "密封条每 {sealCheckWeeks} 周检查一次，出现破损、变形或闭合不严时立即报修并记录。设备内部照明与温度显示装置故障的，应在当日报修。",
          "除霜与清洁作业完成后应确认设备恢复至设定温度，并在维护记录中登记完成时间。"
        ]
      },
      {
        heading: "3 加热与保温设备维护",
        paragraphs: [
          "加热设备应定期检查加热元件、温控器与安全保护装置，发现温度失控、异常声响或漏电迹象时立即停用并报修。",
          "保温与展示设备应保持内部清洁，风机与出风口的积尘应定期清理，清理后确认出风正常、温度回稳。"
        ]
      },
      {
        heading: "4 虫害控制设施",
        params: [2],
        paragraphs: [
          "门店应按总部要求配置粘鼠板、灭蝇灯与防虫门帘等设施，数量与点位不得随意变动。灭蝇灯每 {flyLampWeeks} 周至少清洁一次，粘捕式设施在粘满或达到说明更换条件时立即更换。",
          "门窗、风幕机、纱窗及下水篦子应保持完好，发现破损应在当日报修。垃圾使用带盖容器存放并做到日产日清。",
          "发现鼠迹、蟑迹或活体虫害时，应上报店长并联系专业服务方处理，处理完成后进行区域性深度清洁与消毒。"
        ]
      },
      {
        heading: "5 故障报修与响应",
        params: [3, 4],
        paragraphs: [
          "设备故障应立即报修并登记故障时间、现象与影响范围。影响温度控制的设备故障，门店应在 {repairHours} 小时内完成报修并采取转移食材等临时措施。",
          "门店应配置必要的备用设备，包括备用温度计、保温箱与备用冷藏空间。备用设备的可用状态每 {sealCheckWeeks} 周确认一次。",
          "维修完成后应验证设备运行状态与温度表现，确认合格后方可恢复常态使用，并在维护记录中登记维修内容与更换配件。"
        ]
      },
      {
        heading: "6 停电与应急",
        paragraphs: [
          "停电时应保持设备门体关闭，减少温度波动，必要时转移食材并记录转移时间与温度。",
          "恢复供电后应确认设备温度稳定在允差范围内，受影响食材是否继续使用由店长根据温度记录判断并记录结论。"
        ]
      },
      {
        heading: "7 记录与复核",
        params: [5],
        paragraphs: [
          "设备维护记录、故障报修记录与虫害处理记录由后厨主管填写，店长每月复核一次，保存期限不少于 {recordYears} 年。",
          "{store}店的设备台账与维护记录在总部抽查时应能够当场提供。"
        ]
      }
    ]
  }
];

/** Query phrasings that ask for one numeric parameter without naming the document. */
export const PARAM_QUERY_TEMPLATES: readonly string[] = [
  "{store}店的{p}是多少",
  "{store}店{p}的标准怎么规定的",
  "{city}的{store}店对{p}有什么要求",
  "{store}店这份规范里{p}写着什么",
  "我们{store}店现在执行的{p}是多少"
];

/** Verbatim-style clause lookups that only exact term matching resolves. */
export const CODE_QUERY_TEMPLATES: readonly string[] = [
  "{doc}",
  "{doc} 是哪份文件",
  "{doc} 规定了什么"
];

/** Queries that ask for a comparison across two stores. */
export const MULTI_HOP_TEMPLATES: readonly string[] = [
  "{a}店和{b}店的{p}有什么不同",
  "{a}店和{b}店{p}哪个要求更严",
  "对比一下{a}店与{b}店的{p}"
];

/** Topics that intentionally do not exist anywhere in the corpus. */
export const NO_ANSWER_QUERIES: readonly string[] = [
  "门店会员积分规则是什么",
  "员工年假有多少天",
  "供应商付款周期是多久",
  "外卖平台的抽成比例是多少",
  "门店店长的月度奖金怎么算",
  "连锁加盟的保证金是多少",
  "菜品毛利率的目标值是多少",
  "门店装修标准是多少钱一平米",
  "员工工服采购预算是多少",
  "门店月度电费预算是多少"
];

/** Archived-only markers that must never appear in a result. */
export const ARCHIVED_MARKER = "停用条款-异味覆盖法";
export const STALE_MARKER = "过期条款-两百摄氏度油温";
