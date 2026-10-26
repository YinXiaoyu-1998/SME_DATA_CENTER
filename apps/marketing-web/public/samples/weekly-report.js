/* eslint-disable -- Supplied, anonymized report runtime; kept in its original form. */

const data = JSON.parse(document.getElementById("report-data").textContent);
const stores = data.comparison;
const fmtWan = (v) => {
  const raw = Number(v || 0) / 10000;
  const value = Math.abs(raw) < 0.05 ? 0 : raw;
  return `${value.toLocaleString("zh-CN", { maximumFractionDigits: 1 })}万`;
};
const fmtNum = (v) => Number(v || 0).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
const fmtYuan = (v) => `${Number(v || 0).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}元`;
const fmtPct = (v) =>
  v === null || v === undefined || v === "" ? "N/A" : `${(Number(v) * 100).toFixed(1)}%`;
const cleanName = (s) => String(s || "");
const colors = {
  teal: "#006d77",
  blue: "#2f5b9f",
  green: "#3a7d44",
  amber: "#b85c00",
  red: "#b23a48",
  violet: "#7557a6",
  orange: "#d96b3b",
  yellow: "#c89b18",
  yellowFill: "#f2c94c",
  maximum: "#2f80ed",
  maximumStroke: "#1c5fb8",
  minimum: "#e5484d",
  minimumStroke: "#b42318"
};
const segmentGroups = data.segment_groups || [];
let selectedTrendKey = "__all__";
let selectedTrendGrain = data.meta.report_grain || "week";
let trendStart = 0,
  trendEnd = null;
let selectedHourlyKey = "__all__";
let selectedStallMixKey = "__all__";
const selectedProductSalesPer10kKeys = { orderRevenue: "__all__", grossSales: "__all__" };
const productSalesPer10kPanels = [
  {
    stateKey: "orderRevenue",
    dataKey: "product_sales_per_10k_order_revenue",
    selectId: "productSalesPer10kStoreSelect",
    searchId: "productSalesPer10kSearch",
    statusId: "productSalesPer10kStatus",
    tableId: "productSalesPer10kTable",
    denominatorLabel: "订单营业收入"
  },
  {
    stateKey: "grossSales",
    dataKey: "product_sales_per_10k_gross_sales",
    selectId: "productSalesPer10kGrossStoreSelect",
    searchId: "productSalesPer10kGrossSearch",
    statusId: "productSalesPer10kGrossStatus",
    tableId: "productSalesPer10kGrossTable",
    denominatorLabel: "营业额"
  }
];
const stallPalette = [
  "#006d77",
  "#2f5b9f",
  "#3a7d44",
  "#b85c00",
  "#7557a6",
  "#d96b3b",
  "#b23a48",
  "#c89b18",
  "#4b5563",
  "#0f766e",
  "#9aa7b5"
];
const currentTrendYear =
  String(data.meta?.target_windows?.current?.end || "").slice(0, 4) || "本年";
const yoyTrendYear = String(data.meta?.target_windows?.yoy?.end || "").slice(0, 4) || "同期";

function setText(id, value) {
  document.getElementById(id).textContent = value;
}
function svg(tag, attrs = {}) {
  const el = document.createElementNS("http:" + "//www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
  return el;
}
function positionTooltip(tip, container, event, options = {}) {
  const bounds = container.getBoundingClientRect();
  const gap = options.gap ?? 12;
  const cursorX = Number.isFinite(event.clientX) ? event.clientX - bounds.left : bounds.width / 2;
  const cursorY = Number.isFinite(event.clientY) ? event.clientY - bounds.top : bounds.height / 2;
  tip.style.display = "block";
  tip.style.left = "0px";
  tip.style.top = "0px";
  const tipWidth = tip.offsetWidth || 0;
  const tipHeight = tip.offsetHeight || 0;
  let x = cursorX + gap;
  let y = cursorY - tipHeight / 2;
  if (x + tipWidth + 8 > bounds.width) x = cursorX - tipWidth - gap;
  x = Math.max(8, Math.min(x, bounds.width - tipWidth - 8));
  y = Math.max(8, Math.min(y, bounds.height - tipHeight - 8));
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
function renderMeta() {
  const meta = data.meta;
  document.getElementById("metaChips").innerHTML = [
    `本周：${meta.target_windows.current.start}-${meta.target_windows.current.end}`,
    `环比：${meta.target_windows.previous.start}-${meta.target_windows.previous.end}`,
    `同比：${meta.target_windows.yoy.start}-${meta.target_windows.yoy.end}`,
    `门店：${meta.store_count}家`
  ]
    .map((x) => `<span class="chip">${x}</span>`)
    .join("");
  if (meta.store_name_contains?.length) {
    const scope = document.createElement("span");
    scope.className = "chip";
    scope.textContent = `门店名称包含：${meta.store_name_contains.join("、")}（全体门店为筛选后合计）`;
    document.getElementById("metaChips").appendChild(scope);
  }
}
function renderKpis() {
  const k = data.kpis;
  setText("heroRevenue", fmtWan(k.current_revenue));
  setText("heroWow", fmtPct(k.wow_pct));
  setText("heroYoy", fmtPct(k.yoy_pct));
  const cards = [
    [
      "业务收入",
      fmtWan(k.current_revenue),
      `环比 ${fmtPct(k.wow_pct)} / 总量同比 ${fmtPct(k.yoy_pct)}`
    ],
    [
      "客流量",
      fmtNum(k.current_customers),
      `环比 ${fmtPct(k.wow_customer_pct)} / 同比 ${fmtPct(k.yoy_customer_pct)}`
    ],
    [
      "开台数",
      fmtNum(k.current_tables),
      `环比 ${fmtPct(k.wow_table_pct)} / 同比 ${fmtPct(k.yoy_table_pct)}`
    ],
    [
      "门店分型",
      `${k.star_count} 明星 / ${k.problem_count} 问题`,
      segmentGroups
        .map((g) => `${g.label} ${g.star_count} 明星/${g.problem_count} 问题`)
        .join("；") || "按门店类型内收入中位数与环比 0% 划分象限"
    ]
  ];
  document.getElementById("kpiCards").innerHTML = cards
    .map(
      (c) =>
        `<div class="card"><div class="label">${c[0]}</div><div class="value">${c[1]}</div><div class="foot">${c[2]}</div></div>`
    )
    .join("");
}
function ruleColor(name) {
  return name === "明星门店"
    ? colors.green
    : name === "问题门店"
      ? colors.red
      : name === "高基盘承压"
        ? colors.amber
        : colors.blue;
}
function renderRules() {
  const rules = data.segment_rules;
  const bucketSegmentSummary = segmentGroups
    .map(
      (group) =>
        `${group.label}：收入中位数 ${fmtWan(group.revenue_threshold)}，${group.star_count} 明星 / ${group.problem_count} 问题`
    )
    .join("；");
  document.getElementById("segmentRules").innerHTML = `
        <div class="rule-note" id="bucketSegmentSummary">门店分型基准：按大店、小店组内比较；${bucketSegmentSummary}。横轴统一使用环比增长率 ${fmtPct(rules.growth_threshold)}。四象限只定义经营位置，预警项用于补充复盘优先级。</div>
        <div class="rule-grid">
          ${rules.items
            .map(
              (item) => `<div class="rule">
            <div class="rule-title"><i class="dot" data-sample-color="${ruleColor(item.name)}"></i>${item.name}</div>
            <p>${item.logic}</p>
            <small>${item.use}</small>
          </div>`
            )
            .join("")}
        </div>
        <div class="rule-note">预警补充：${rules.warnings}</div>`;
}
function renderHorizontalBar(id, rows, field, formatter, color) {
  const el = document.getElementById(id);
  const w = 760,
    h = Math.max(300, rows.length * 32 + 48),
    left = 150,
    right = 80;
  const max = Math.max(...rows.map((r) => Math.abs(Number(r[field] || 0))), 1);
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}` });
  rows.forEach((r, i) => {
    const y = 28 + i * 32;
    const val = Number(r[field] || 0);
    const bw = (Math.abs(val) / max) * (w - left - right);
    root.appendChild(
      svg("text", {
        x: left - 8,
        y: y + 15,
        "text-anchor": "end",
        "font-size": "12",
        fill: "#344054"
      })
    ).textContent = cleanName(r["门店名称"]);
    root.appendChild(svg("rect", { x: left, y, width: bw, height: 18, rx: 4, fill: color }));
    root.appendChild(
      svg("text", { x: left + bw + 8, y: y + 14, "font-size": "12", fill: "#657386" })
    ).textContent = formatter(val);
  });
  el.innerHTML = "";
  el.appendChild(root);
}
function renderBucketedRevenueRanking() {
  const el = document.getElementById("revenueBar");
  const groups = segmentGroups.length
    ? segmentGroups
    : [
        { label: "全体门店", rows: stores, revenue_threshold: data.segment_rules.revenue_threshold }
      ];
  const w = 760,
    left = 150,
    right = 80,
    groupGap = 40;
  const rowH = 30;
  const totalRows = groups.reduce((sum, group) => sum + (group.rows || []).length, 0);
  const h = Math.max(320, totalRows * rowH + groups.length * groupGap + 36);
  const max = Math.max(
    ...groups.flatMap((group) => (group.rows || []).map((r) => Number(r.current_net_revenue || 0))),
    1
  );
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}` });
  let y = 26;
  groups.forEach((group) => {
    root.appendChild(
      svg("text", {
        x: left - 8,
        y: y,
        "text-anchor": "end",
        "font-size": "12",
        fill: "#172033",
        "font-weight": "800"
      })
    ).textContent = `${group.label}（${group.store_count || (group.rows || []).length}家）`;
    root.appendChild(
      svg("text", { x: left, y: y, "font-size": "11", fill: "#657386" })
    ).textContent = `中位数 ${fmtWan(group.revenue_threshold || 0)}`;
    y += 12;
    (group.rows || []).forEach((r) => {
      y += rowH;
      const val = Number(r.current_net_revenue || 0);
      const bw = (val / max) * (w - left - right);
      root.appendChild(
        svg("text", {
          x: left - 8,
          y: y + 5,
          "text-anchor": "end",
          "font-size": "12",
          fill: "#344054"
        })
      ).textContent = cleanName(r["门店名称"]);
      root.appendChild(
        svg("rect", { x: left, y: y - 11, width: bw, height: 18, rx: 4, fill: colors.teal })
      );
      root.appendChild(
        svg("text", { x: left + bw + 8, y: y + 3, "font-size": "12", fill: "#657386" })
      ).textContent = fmtWan(val);
    });
    y += groupGap - 10;
  });
  el.innerHTML = "";
  el.appendChild(root);
}
function renderGrowthBar() {
  const el = document.getElementById("growthBar");
  const rows = stores
    .slice()
    .sort((a, b) => Number(b.wow_net_revenue_pct || 0) - Number(a.wow_net_revenue_pct || 0));
  const primaryMetrics = [
    { field: "wow_net_revenue_pct", label: "业务收入环比", color: "#006d77" },
    { field: "yoy_net_revenue_pct", label: "业务收入同比", color: "#1d4ed8" }
  ];
  const channelRows = [
    {
      label: "堂食",
      metrics: [
        {
          field: "wow_dine_in_revenue_pct",
          label: "堂食环比",
          shortLabel: "环比",
          color: "#2e7d32"
        },
        {
          field: "yoy_dine_in_revenue_pct",
          label: "堂食同比",
          shortLabel: "同比",
          color: "#7c3aed"
        }
      ]
    },
    {
      label: "外卖",
      metrics: [
        {
          field: "wow_delivery_revenue_pct",
          label: "外卖环比",
          shortLabel: "环比",
          color: "#f59e0b"
        },
        {
          field: "yoy_delivery_revenue_pct",
          label: "外卖同比",
          shortLabel: "同比",
          color: "#dc2626"
        }
      ]
    }
  ];
  const primaryValues = rows.flatMap((row) =>
    primaryMetrics.map((metric) => Number(row[metric.field] || 0))
  );
  const channelValues = rows.flatMap((row) =>
    channelRows.flatMap((channel) =>
      channel.metrics.map((metric) => Number(row[metric.field] || 0))
    )
  );
  const primaryMax = Math.max(...primaryValues.map((value) => Math.abs(value)), 0.01);
  const channelMax = Math.max(...channelValues.map((value) => Math.abs(value)), 0.01);

  function signedGrowthAxis(rawValue, color, maxValue, ariaLabel) {
    const hasValue = rawValue !== null && rawValue !== undefined && rawValue !== "";
    const value = hasValue ? Number(rawValue) : null;
    const w = 420,
      h = 28,
      mid = 210,
      maxBar = 154;
    const root = svg("svg", {
      viewBox: `0 0 ${w} ${h}`,
      role: "img",
      "aria-label": `${ariaLabel} ${fmtPct(value)}`
    });
    root.appendChild(svg("line", { x1: mid, y1: 2, x2: mid, y2: h - 2, stroke: "#cbd8e3" }));
    if (value === null || !Number.isFinite(value)) {
      root.appendChild(
        svg("text", { x: mid + 8, y: 18, "font-size": "11", fill: "#8a97a8" })
      ).textContent = "N/A";
      return root;
    }
    const width = (Math.abs(value) / maxValue) * maxBar;
    const x = value >= 0 ? mid : mid - width;
    root.appendChild(
      svg("rect", {
        x,
        y: 8,
        width: Math.max(width, value === 0 ? 1 : 2),
        height: 12,
        rx: 3,
        fill: color
      })
    );
    root.appendChild(
      svg("text", {
        x: value >= 0 ? x + width + 8 : x - 8,
        y: 18,
        "text-anchor": value >= 0 ? "start" : "end",
        "font-size": "11",
        fill: "#657386",
        "font-weight": "700"
      })
    ).textContent = fmtPct(value);
    return root;
  }

  const legend = document.createElement("div");
  legend.className = "growth-legend";
  primaryMetrics.forEach((metric) => {
    const item = document.createElement("span");
    item.innerHTML = `<i class="swatch" data-sample-color="${metric.color}"></i>${metric.label}`;
    legend.appendChild(item);
  });
  const axisNote = document.createElement("span");
  axisNote.textContent = "每项独立成行；0% 为中心线";
  legend.appendChild(axisNote);

  const board = document.createElement("div");
  board.className = "growth-board";
  rows.forEach((row, index) => {
    const store = document.createElement("section");
    store.className = "growth-store";

    const head = document.createElement("div");
    head.className = "growth-store-head";
    const storeName = document.createElement("div");
    storeName.className = "growth-store-name";
    storeName.textContent = cleanName(row["门店名称"]);

    const primary = document.createElement("div");
    primary.className = "growth-primary";
    primaryMetrics.forEach((metric) => {
      const metricRow = document.createElement("div");
      metricRow.className = "growth-primary-row";
      const label = document.createElement("span");
      label.className = "growth-metric-label";
      label.textContent = metric.label;
      const axis = document.createElement("div");
      axis.className = "growth-axis";
      axis.appendChild(signedGrowthAxis(row[metric.field], metric.color, primaryMax, metric.label));
      metricRow.append(label, axis);
      primary.appendChild(metricRow);
    });

    const detailId = `growth-channel-detail-${index}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "growth-toggle";
    button.textContent = "查看渠道明细 ▾";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", detailId);
    button.setAttribute("aria-label", `${cleanName(row["门店名称"])} 查看渠道明细`);
    head.append(storeName, primary, button);

    const detail = document.createElement("div");
    detail.id = detailId;
    detail.className = "growth-channel-detail";
    detail.hidden = true;
    channelRows.forEach((channel) => {
      const channelRow = document.createElement("div");
      channelRow.className = "growth-channel-row";
      const channelName = document.createElement("div");
      channelName.className = "growth-channel-name";
      channelName.textContent = channel.label;
      channelRow.appendChild(channelName);
      channel.metrics.forEach((metric) => {
        const metricCell = document.createElement("div");
        metricCell.className = "growth-channel-metric";
        const label = document.createElement("span");
        label.className = "growth-metric-label";
        label.textContent = metric.shortLabel;
        label.style.color = metric.color;
        const axis = document.createElement("div");
        axis.className = "growth-axis";
        axis.appendChild(
          signedGrowthAxis(row[metric.field], metric.color, channelMax, metric.label)
        );
        metricCell.append(label, axis);
        channelRow.appendChild(metricCell);
      });
      detail.appendChild(channelRow);
    });

    button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") !== "true";
      button.setAttribute("aria-expanded", String(expanded));
      detail.hidden = !expanded;
      button.textContent = expanded ? "收起渠道明细 ▴" : "查看渠道明细 ▾";
      button.setAttribute(
        "aria-label",
        `${cleanName(row["门店名称"])} ${expanded ? "收起渠道明细" : "查看渠道明细"}`
      );
    });
    store.append(head, detail);
    board.appendChild(store);
  });
  el.innerHTML = "";
  el.append(legend, board);
}
function renderBucketedScatter() {
  const el = document.getElementById("scatter");
  const groups = segmentGroups.length
    ? segmentGroups
    : [
        {
          label: "全体门店",
          rows: stores,
          revenue_threshold: data.segment_rules.revenue_threshold,
          growth_threshold: 0
        }
      ];
  const w = 760,
    panelH = 260,
    h = Math.max(330, groups.length * panelH + 18),
    left = 58,
    right = 28,
    topPad = 34,
    bottom = 40;
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}` });
  groups.forEach((group, groupIndex) => {
    const rows = group.rows || [];
    const top = groupIndex * panelH + topPad;
    const axisBottom = (groupIndex + 1) * panelH - bottom;
    const xs = rows.map((r) => Number(r.wow_net_revenue_pct || 0));
    const ys = rows.map((r) => Number(r.current_net_revenue || 0));
    const minX = Math.min(...xs, -0.01),
      maxX = Math.max(...xs, 0.01),
      maxY = Math.max(...ys, 1);
    const revenueThreshold = Number(group.revenue_threshold || 0);
    const growthThreshold = Number(group.growth_threshold || 0);
    const xScale = (v) => left + ((v - minX) / (maxX - minX || 1)) * (w - left - right);
    const yScale = (v) => axisBottom - (v / maxY) * (axisBottom - top);
    root.appendChild(
      svg("text", {
        x: left,
        y: top - 14,
        "font-size": "13",
        fill: "#172033",
        "font-weight": "800"
      })
    ).textContent = `${group.label}四象限`;
    root.appendChild(
      svg("text", {
        x: w - right,
        y: top - 14,
        "text-anchor": "end",
        "font-size": "11",
        fill: "#657386"
      })
    ).textContent = `收入中位数 ${fmtWan(revenueThreshold)}`;
    root.appendChild(
      svg("line", { x1: left, y1: axisBottom, x2: w - right, y2: axisBottom, stroke: "#9aa7b5" })
    );
    root.appendChild(
      svg("line", { x1: left, y1: top, x2: left, y2: axisBottom, stroke: "#9aa7b5" })
    );
    root.appendChild(
      svg("line", {
        x1: xScale(growthThreshold),
        y1: top,
        x2: xScale(growthThreshold),
        y2: axisBottom,
        stroke: "#cfd9e3",
        "stroke-dasharray": "5 5"
      })
    );
    root.appendChild(
      svg("line", {
        x1: left,
        y1: yScale(revenueThreshold),
        x2: w - right,
        y2: yScale(revenueThreshold),
        stroke: "#cfd9e3",
        "stroke-dasharray": "5 5"
      })
    );
    [
      ["高基盘承压", left + 10, top + 17, colors.amber],
      ["明星门店", Math.min(w - right - 88, xScale(growthThreshold) + 10), top + 17, colors.green],
      ["问题门店", left + 10, axisBottom - 12, colors.red],
      [
        "成长观察",
        Math.min(w - right - 88, xScale(growthThreshold) + 10),
        axisBottom - 12,
        colors.blue
      ]
    ].forEach(([label, x, y, color]) => {
      root.appendChild(
        svg("text", { x, y, "font-size": "10", fill: color, "font-weight": "800", opacity: 0.78 })
      ).textContent = label;
    });
    const placedLabels = [];
    rows.forEach((r) => {
      const seg = r.segment;
      const fill =
        seg === "明星门店"
          ? colors.green
          : seg === "问题门店"
            ? colors.red
            : seg === "高基盘承压"
              ? colors.amber
              : colors.blue;
      const radius = 7 + Math.min(12, Number(r.current_discount_rate || 0) * 35);
      const cx = xScale(Number(r.wow_net_revenue_pct || 0));
      const cy = yScale(Number(r.current_net_revenue || 0));
      root.appendChild(svg("circle", { cx, cy, r: radius, fill, opacity: 0.82 }));
      let anchor = "start";
      let lx = cx + radius + 4;
      let ly = cy + 4;
      if (cx > w - right - 90) {
        anchor = "end";
        lx = cx - radius - 4;
      }
      let guard = 0;
      while (
        placedLabels.some((p) => Math.abs(p.x - lx) < 92 && Math.abs(p.y - ly) < 15) &&
        guard < 8
      ) {
        ly += 15;
        if (ly > axisBottom - 8) ly = cy - 12 - guard * 10;
        guard += 1;
      }
      placedLabels.push({ x: lx, y: ly });
      root.appendChild(
        svg("text", {
          x: lx,
          y: ly,
          "text-anchor": anchor,
          "font-size": "11",
          fill: "#344054",
          stroke: "#fff",
          "stroke-width": 3,
          "paint-order": "stroke"
        })
      ).textContent = cleanName(r["门店名称"]);
    });
  });
  root.appendChild(
    svg("text", {
      x: w / 2,
      y: h - 10,
      "text-anchor": "middle",
      "font-size": "12",
      fill: "#657386"
    })
  ).textContent = "环比增长率";
  el.innerHTML = "";
  el.appendChild(root);
}
function currentTrendView() {
  return (
    (data.trend_by_grain || {})[selectedTrendGrain] || {
      entities: data.trend_entities || [{ key: "__all__", label: "全体门店", rows: data.trend }],
      note: data.trend_note || ""
    }
  );
}
function currentTrendEntity() {
  const entities = currentTrendView().entities;
  return (
    entities.find((item) => item.key === selectedTrendKey) ||
    entities[0] || { key: "__all__", label: "全体门店", rows: [] }
  );
}
function setTrendRange(start, end) {
  const count = (currentTrendEntity().rows || []).length;
  if (!count) return;
  trendStart = Math.max(0, Math.min(Math.round(start), count - 1));
  trendEnd = Math.max(trendStart, Math.min(Math.round(end), count - 1));
  renderTrend();
}
function renderTrendControls() {
  const rows = currentTrendEntity().rows || [];
  const presetOptions = {
    day: [
      [7, "最近 7 天"],
      [30, "最近 30 天"],
      [90, "最近 90 天"],
      [0, "全年"]
    ],
    week: [
      [2, "最近 2 周"],
      [5, "最近 5 周"],
      [16, "最近 16 周"],
      [0, "全年"]
    ],
    month: [
      [2, "最近 2 个月"],
      [6, "最近 6 个月"],
      [0, "全年"]
    ]
  };
  const presets = document.getElementById("trendPresets");
  presets.replaceChildren();
  presetOptions[selectedTrendGrain].forEach(([size, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.size = size;
    button.addEventListener("click", () => {
      const count = (currentTrendEntity().rows || []).length;
      setTrendRange(size ? Math.max(0, count - size) : 0, count - 1);
    });
    presets.appendChild(button);
  });
  ["trendStartSelect", "trendEndSelect"].forEach((id) => {
    const select = document.getElementById(id);
    select.replaceChildren();
    rows.forEach((row, index) => {
      const option = document.createElement("option");
      option.value = index;
      option.textContent = row.current_week_range || row.week_label;
      select.appendChild(option);
    });
    select.disabled = !rows.length;
    select.onchange = () => {
      const value = Number(select.value);
      if (id === "trendStartSelect") setTrendRange(value, Math.max(value, trendEnd));
      else setTrendRange(Math.min(trendStart, value), value);
    };
  });
  const navigator = document.getElementById("trendNavigator");
  if (navigator.dataset.bound) return;
  navigator.dataset.bound = "true";
  let drag = null;
  const boundary = (event) => {
    const bounds = navigator.getBoundingClientRect();
    const count = (currentTrendEntity().rows || []).length;
    return Math.max(
      0,
      Math.min(count, Math.round(((event.clientX - bounds.left) / bounds.width) * count))
    );
  };
  navigator.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !(currentTrendEntity().rows || []).length) return;
    const mode = event.target.getAttribute("data-drag") || "select";
    drag = { mode, anchor: boundary(event), start: trendStart, end: trendEnd };
    navigator.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  navigator.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const value = boundary(event);
    const count = (currentTrendEntity().rows || []).length;
    if (drag.mode === "start") setTrendRange(Math.min(value, drag.end), drag.end);
    else if (drag.mode === "end") setTrendRange(drag.start, Math.max(drag.start, value - 1));
    else if (drag.mode === "pan") {
      const offset = Math.max(-drag.start, Math.min(value - drag.anchor, count - 1 - drag.end));
      setTrendRange(drag.start + offset, drag.end + offset);
    } else setTrendRange(Math.min(value, drag.anchor), Math.max(value, drag.anchor) - 1);
  });
  const endDrag = () => {
    drag = null;
  };
  navigator.addEventListener("pointerup", endDrag);
  navigator.addEventListener("pointercancel", endDrag);
  navigator.addEventListener("lostpointercapture", endDrag);
}
function renderTrendNavigator(rows, currentField, priorField) {
  const el = document.getElementById("trendNavigator");
  const root = svg("svg", {
    viewBox: "0 0 1120 64",
    preserveAspectRatio: "none",
    "aria-hidden": "true"
  });
  root.appendChild(
    svg("rect", {
      x: 0,
      y: 0,
      width: 1120,
      height: 64,
      rx: 6,
      fill: "#f4f7fa",
      "data-drag": "select"
    })
  );
  const max = Math.max(
    1,
    ...rows.flatMap((row) => [Number(row[currentField] || 0), Number(row[priorField] || 0)])
  );
  [currentField, priorField].forEach((field, series) => {
    let segment = [];
    const flush = () => {
      if (segment.length)
        root.appendChild(
          svg("polyline", {
            points: segment.join(" "),
            fill: "none",
            stroke: colors.yellow,
            "stroke-width": 2,
            ...(series ? { "stroke-dasharray": "5 4" } : {}),
            "pointer-events": "none"
          })
        );
      segment = [];
    };
    rows.forEach((row, index) => {
      const value = row[field];
      if (value === null || value === undefined || value === "") {
        flush();
        return;
      }
      segment.push(`${((index + 0.5) / rows.length) * 1120},${56 - (Number(value) / max) * 48}`);
    });
    flush();
  });
  const startX = (trendStart / rows.length) * 1120;
  const endX = ((trendEnd + 1) / rows.length) * 1120;
  [
    [0, startX],
    [endX, 1120 - endX]
  ].forEach(([x, width]) =>
    root.appendChild(
      svg("rect", {
        x,
        y: 0,
        width,
        height: 64,
        fill: "#dbe4ef",
        opacity: 0.65,
        "data-drag": "select"
      })
    )
  );
  root.appendChild(
    svg("rect", {
      x: startX,
      y: 1,
      width: endX - startX,
      height: 62,
      fill: "#2563eb",
      "fill-opacity": 0.08,
      stroke: "#2563eb",
      "stroke-width": 2,
      "data-drag": "pan",
      style: "cursor:grab"
    })
  );
  [
    [startX, "start"],
    [endX, "end"]
  ].forEach(([x, mode]) => {
    root.appendChild(
      svg("rect", {
        x: Math.max(0, Math.min(1104, x - 8)),
        y: 0,
        width: 16,
        height: 64,
        rx: 4,
        fill: "#2563eb",
        "data-drag": mode,
        style: "cursor:ew-resize"
      })
    );
  });
  el.replaceChildren(root);
}
function renderTrendSelector() {
  const select = document.getElementById("trendStoreSelect");
  const entities = currentTrendView().entities;
  select.replaceChildren();
  entities.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.key;
    option.textContent = cleanName(item.label);
    select.appendChild(option);
  });
  selectedTrendKey = currentTrendEntity().key;
  select.value = selectedTrendKey;
  select.onchange = () => {
    selectedTrendKey = select.value;
    renderTrend();
  };
  const grainSelect = document.getElementById("trendGrainSelect");
  grainSelect.replaceChildren();
  [
    ["day", "日"],
    ["week", "周"],
    ["month", "月"]
  ].forEach(([grain, label]) => {
    if (!(data.trend_by_grain || {})[grain] && grain !== data.meta.report_grain) return;
    const option = document.createElement("option");
    option.value = grain;
    option.textContent = label;
    grainSelect.appendChild(option);
  });
  grainSelect.value = selectedTrendGrain;
  grainSelect.onchange = () => {
    selectedTrendGrain = grainSelect.value;
    trendStart = 0;
    trendEnd = null;
    renderTrendSelector();
    renderTrend();
  };
  renderTrendControls();
}
function renderTrend() {
  const el = document.getElementById("trend");
  const entity = currentTrendEntity();
  const allRows = entity.rows || [];
  if (!allRows.length) {
    el.replaceChildren();
    document.getElementById("trendNavigator").replaceChildren();
    document.getElementById("trendControls").hidden = true;
    return;
  }
  trendEnd = Math.min(trendEnd ?? allRows.length - 1, allRows.length - 1);
  trendStart = Math.min(trendStart, trendEnd);
  const rows = allRows.slice(trendStart, trendEnd + 1);
  const yearLabel = (field, fallback) => {
    const first = String(rows[0][field] || "").slice(0, 4);
    const last = String(rows[rows.length - 1][field] || "").slice(11, 15);
    return first && last ? (first === last ? first : `${first}–${last}`) : fallback;
  };
  const currentLabel = yearLabel("current_week_range", currentTrendYear);
  const priorLabel = yearLabel("prior_week_range", yoyTrendYear);
  const isAllStores = entity.key === "__all__";
  const units = { day: "天", week: "周", month: "个月" };
  const basis = { day: "每日", week: "完整周", month: "完整自然月" }[selectedTrendGrain];
  document.getElementById("trendTitle").textContent =
    `最近一年收入趋势（${allRows.length} ${units[selectedTrendGrain]}）`;
  document.getElementById("trendMetricLabel").textContent =
    `${basis} · ${isAllStores ? "整体" : cleanName(entity.label)}业务收入（万元）；实线=${currentLabel}，虚线=${priorLabel}同期`;
  document.getElementById("trendControls").hidden = false;
  const w = 1120,
    h = 360,
    left = 82,
    right = 84,
    top = 34,
    bottom = 78;
  const hasComparisonShape = rows.some(
    (r) =>
      Object.prototype.hasOwnProperty.call(r, "current_net_revenue") ||
      Object.prototype.hasOwnProperty.call(r, "prior_net_revenue")
  );
  const currentField = hasComparisonShape ? "current_net_revenue" : "net_revenue";
  const priorField = "prior_net_revenue";
  const allValues = rows.flatMap((r) => [Number(r[currentField] || 0), Number(r[priorField] || 0)]);
  const max = Math.max(...allValues, 1);
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = magnitude / 2;
  const yMax = Math.ceil(max / step) * step;
  const yScale = (v) => h - bottom - (Number(v || 0) / yMax) * (h - top - bottom);
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}` });
  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    const value = yMax * t;
    const y = yScale(value);
    root.appendChild(svg("line", { x1: left, y1: y, x2: w - right, y2: y, stroke: "#e6edf3" }));
    root.appendChild(
      svg("text", {
        x: left - 10,
        y: y + 4,
        "text-anchor": "end",
        "font-size": "11",
        fill: "#657386"
      })
    ).textContent = fmtWan(value);
  });
  root.appendChild(svg("line", { x1: left, y1: top, x2: left, y2: h - bottom, stroke: "#9aa7b5" }));
  root.appendChild(
    svg("line", { x1: left, y1: h - bottom, x2: w - right, y2: h - bottom, stroke: "#9aa7b5" })
  );

  function trendPoints(field) {
    return rows
      .map((r, i) => {
        const raw = r[field];
        if (raw === null || raw === undefined || raw === "") return null;
        const x =
          rows.length === 1
            ? (w + left - right) / 2
            : left + (i / (rows.length - 1)) * (w - left - right);
        const y = yScale(Number(raw || 0));
        return [x, y, r, Number(raw || 0), i];
      })
      .filter(Boolean);
  }
  function drawTrendLine(field, color, dash, rangeField) {
    const points = trendPoints(field);
    if (!points.length) return;
    const values = points.map(([, , , value]) => value);
    const minValue = Math.min(...values),
      maxValue = Math.max(...values);
    const hasDistinctExtremes = points.length > 1 && minValue !== maxValue;
    const segments = [];
    points.forEach((point) => {
      const last = segments[segments.length - 1];
      if (!last || point[4] !== last[last.length - 1][4] + 1) segments.push([point]);
      else last.push(point);
    });
    segments.forEach((segment) =>
      root.appendChild(
        svg("polyline", {
          points: segment.map((p) => `${p[0]},${p[1]}`).join(" "),
          fill: "none",
          stroke: color,
          "stroke-width": 3,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          ...(dash ? { "stroke-dasharray": dash } : {})
        })
      )
    );
    points.forEach(([x, y, r, value], i) => {
      if (points.length > 60 && i !== points.length - 1 && value !== minValue && value !== maxValue)
        return;
      const isMin = hasDistinctExtremes && value === minValue;
      const isMax = hasDistinctExtremes && value === maxValue;
      const point = svg("circle", {
        cx: x,
        cy: y,
        r: 5,
        fill: isMin ? colors.minimum : isMax ? colors.maximum : colors.yellowFill,
        stroke: isMin ? colors.minimumStroke : isMax ? colors.maximumStroke : color,
        "stroke-width": 2,
        style: "cursor:pointer"
      });
      const weekLabel = String(r.week_label || "");
      const pointRange = String(r[rangeField] || weekLabel);
      const title = svg("title", {});
      title.textContent = `${pointRange} 业务收入：${fmtWan(value)}`;
      point.appendChild(title);
      root.appendChild(point);
      if (i === points.length - 1) {
        const labelY = field === priorField ? y + 19 : y - 9;
        root.appendChild(
          svg("text", {
            x: x - 7,
            y: labelY,
            "text-anchor": "end",
            "font-size": "11",
            fill: color,
            "font-weight": "800"
          })
        ).textContent = fmtWan(value);
      }
    });
  }
  drawTrendLine(
    currentField,
    colors.yellow,
    "",
    hasComparisonShape ? "current_week_range" : "week_label"
  );
  if (hasComparisonShape) drawTrendLine(priorField, colors.yellow, "7 5", "prior_week_range");

  rows.forEach((r, i) => {
    const x =
      rows.length === 1
        ? (w + left - right) / 2
        : left + (i / (rows.length - 1)) * (w - left - right);
    if (i % Math.max(1, Math.ceil(rows.length / 10)) === 0 || i === rows.length - 1) {
      const anchor = i === rows.length - 1 ? "end" : "middle";
      const tx = i === rows.length - 1 ? x - 4 : x;
      root.appendChild(
        svg("text", {
          x: tx,
          y: h - 42,
          "text-anchor": anchor,
          "font-size": "10",
          fill: "#657386",
          transform: `rotate(-32 ${tx} ${h - 42})`
        })
      ).textContent = r.current_week_range
        ? String(r.current_week_range).slice(0, 10)
        : String(r.week_label);
    }
  });
  root.appendChild(
    svg("line", {
      x1: left + 190,
      y1: 15,
      x2: left + 232,
      y2: 15,
      stroke: colors.yellow,
      "stroke-width": 3,
      "stroke-linecap": "round"
    })
  );
  root.appendChild(
    svg("text", { x: left + 240, y: 19, "font-size": "11", fill: "#657386" })
  ).textContent = currentLabel;
  if (hasComparisonShape) {
    root.appendChild(
      svg("line", {
        x1: left + 362,
        y1: 15,
        x2: left + 404,
        y2: 15,
        stroke: colors.yellow,
        "stroke-width": 3,
        "stroke-dasharray": "7 5",
        "stroke-linecap": "round"
      })
    );
    root.appendChild(
      svg("text", { x: left + 412, y: 19, "font-size": "11", fill: "#657386" })
    ).textContent = `${priorLabel}同期`;
  }
  root.appendChild(
    svg("text", { x: left, y: 18, "font-size": "12", fill: "#657386", "font-weight": "700" })
  ).textContent = "业务收入（万元）";
  el.innerHTML = "";
  el.appendChild(root);
  const guide = svg("line", {
    x1: left,
    x2: left,
    y1: top,
    y2: h - bottom,
    stroke: "#657386",
    "stroke-width": 1,
    "stroke-dasharray": "4 4",
    visibility: "hidden",
    "pointer-events": "none",
    "data-trend-guide": "true"
  });
  root.appendChild(guide);
  const markers = [currentField, priorField].map((field, series) => {
    const marker = svg("circle", {
      r: 6,
      fill: series ? "white" : colors.yellowFill,
      stroke: colors.yellow,
      "stroke-width": 3,
      visibility: "hidden",
      "pointer-events": "none",
      "data-trend-marker": field
    });
    root.appendChild(marker);
    return marker;
  });
  const readout = document.getElementById("trendReadout");
  let activeIndex = rows.length - 1;
  const valueText = (value) =>
    value === null || value === undefined || value === "" ? "暂无记录" : fmtYuan(value);
  const showIndex = (index, visible = true) => {
    activeIndex = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[activeIndex];
    const x =
      rows.length === 1
        ? (w + left - right) / 2
        : left + (activeIndex / (rows.length - 1)) * (w - left - right);
    guide.setAttribute("x1", x);
    guide.setAttribute("x2", x);
    guide.setAttribute("visibility", visible ? "visible" : "hidden");
    [currentField, priorField].forEach((field, series) => {
      const value = row[field];
      const present = value !== null && value !== undefined && value !== "";
      markers[series].setAttribute("cx", x);
      markers[series].setAttribute("cy", yScale(value));
      markers[series].setAttribute("visibility", visible && present ? "visible" : "hidden");
    });
    readout.replaceChildren();
    [
      [row.current_week_range || row.week_label, row[currentField], "本期"],
      [row.prior_week_range, row[priorField], "同期"]
    ].forEach(([range, value, label]) => {
      const line = document.createElement("div");
      const dateLabel =
        range && range.slice(0, 10) === range.slice(11) ? range.slice(0, 10) : range;
      line.textContent = `${label} ${dateLabel || "无对应日期"} · 业务收入：${valueText(value)}`;
      readout.appendChild(line);
    });
  };
  const overlay = svg("rect", {
    x: left,
    y: top,
    width: w - left - right,
    height: h - top - bottom,
    fill: "transparent",
    tabindex: 0,
    role: "img",
    "aria-label": "收入趋势，左右方向键逐期查看，Home 和 End 跳到首尾",
    "data-trend-overlay": "true",
    style: "cursor:crosshair;touch-action:pan-y"
  });
  overlay.addEventListener("pointermove", (event) => {
    const bounds = root.getBoundingClientRect();
    const matrix = root.getScreenCTM?.();
    const x = matrix
      ? (event.clientX - matrix.e) / matrix.a
      : ((event.clientX - bounds.left) / bounds.width) * w;
    showIndex(Math.round(((x - left) / (w - left - right)) * (rows.length - 1)));
  });
  overlay.addEventListener("pointerleave", () => showIndex(rows.length - 1, false));
  overlay.addEventListener("focus", () => showIndex(activeIndex));
  overlay.addEventListener("blur", () => showIndex(rows.length - 1, false));
  overlay.addEventListener("keydown", (event) => {
    const next = {
      ArrowLeft: activeIndex - 1,
      ArrowRight: activeIndex + 1,
      Home: 0,
      End: rows.length - 1
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    showIndex(next);
  });
  root.appendChild(overlay);
  showIndex(rows.length - 1, false);
  document.getElementById("trendStartSelect").value = trendStart;
  document.getElementById("trendEndSelect").value = trendEnd;
  const start = rows[0].current_week_range || rows[0].week_label;
  const end = rows[rows.length - 1].current_week_range || rows[rows.length - 1].week_label;
  const label =
    start.includes("-") && start.length === 21
      ? `${start.slice(0, 10)} 至 ${end.slice(11)}`
      : `${start} 至 ${end}`;
  document.getElementById("trendRangeLabel").textContent =
    `当前显示：${label}（${rows.length} ${units[selectedTrendGrain]}） · ${currentTrendView().note}`;
  document.querySelectorAll("#trendPresets button").forEach((button) => {
    const size = Number(button.dataset.size) || allRows.length;
    button.disabled = !allRows.length;
    button.setAttribute(
      "aria-pressed",
      String(trendEnd === allRows.length - 1 && rows.length === Math.min(size, allRows.length))
    );
  });
  renderTrendNavigator(allRows, currentField, priorField);
}
function renderMixBars() {
  const rows = stores;
  const el = document.getElementById("mixBar");
  const w = 760,
    h = Math.max(310, rows.length * 32 + 46),
    left = 150,
    right = 70;
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}` });
  const max = Math.max(...rows.map((r) => Number(r.current_net_revenue || 0)), 1);
  rows.forEach((r, i) => {
    const y = 26 + i * 32;
    const total = Number(r.current_net_revenue || 0);
    const dine = Number(r.current_dine_in_revenue || 0);
    const del = Number(r.current_delivery_revenue || 0);
    const other = Math.max(0, total - dine - del);
    let x = left;
    root.appendChild(
      svg("text", {
        x: left - 8,
        y: y + 15,
        "text-anchor": "end",
        "font-size": "12",
        fill: "#344054"
      })
    ).textContent = cleanName(r["门店名称"]);
    [
      [dine, colors.teal],
      [del, colors.blue],
      [other, colors.amber]
    ].forEach(([v, c]) => {
      const bw = (v / max) * (w - left - right);
      root.appendChild(svg("rect", { x, y, width: bw, height: 18, rx: 2, fill: c }));
      x += bw;
    });
    root.appendChild(
      svg("text", {
        x: left + (total / max) * (w - left - right) + 8,
        y: y + 14,
        "font-size": "12",
        fill: "#657386"
      })
    ).textContent = fmtWan(total);
  });
  el.innerHTML = "";
  el.appendChild(root);
}
function renderPlatformBars() {
  const rows = stores;
  const el = document.getElementById("platformBar");
  const w = 760,
    h = Math.max(310, rows.length * 32 + 46),
    left = 150,
    right = 70;
  const max = Math.max(
    ...rows.map(
      (r) =>
        Number(r.current_meituan_delivery_revenue || 0) +
        Number(r.current_eleme_delivery_revenue || 0) +
        Number(r.current_jd_delivery_revenue || 0)
    ),
    1
  );
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}` });
  rows.forEach((r, i) => {
    const y = 26 + i * 32;
    const vals = [
      [Number(r.current_meituan_delivery_revenue || 0), colors.green],
      [Number(r.current_eleme_delivery_revenue || 0), colors.violet],
      [Number(r.current_jd_delivery_revenue || 0), colors.orange]
    ];
    let x = left,
      total = vals.reduce((s, v) => s + v[0], 0);
    root.appendChild(
      svg("text", {
        x: left - 8,
        y: y + 15,
        "text-anchor": "end",
        "font-size": "12",
        fill: "#344054"
      })
    ).textContent = cleanName(r["门店名称"]);
    vals.forEach(([v, c]) => {
      const bw = (v / max) * (w - left - right);
      root.appendChild(svg("rect", { x, y, width: bw, height: 18, rx: 2, fill: c }));
      x += bw;
    });
    root.appendChild(
      svg("text", {
        x: left + (total / max) * (w - left - right) + 8,
        y: y + 14,
        "font-size": "12",
        fill: "#657386"
      })
    ).textContent = fmtWan(total);
  });
  el.innerHTML = "";
  el.appendChild(root);
}
function currentStallMixEntity() {
  const entities = data.stall_sales_mix?.entities || [];
  return entities.find((item) => item.key === selectedStallMixKey) || entities[0];
}
function renderStallMixSelector() {
  const select = document.getElementById("stallMixStoreSelect");
  if (!select) return;
  const entities = data.stall_sales_mix?.entities || [];
  if (!entities.length) {
    select.innerHTML = "";
    return;
  }
  select.innerHTML = entities
    .map((item) => `<option value="${item.key}">${cleanName(item.label)}</option>`)
    .join("");
  if (!entities.some((item) => item.key === selectedStallMixKey))
    selectedStallMixKey = entities[0].key;
  select.value = selectedStallMixKey;
  select.addEventListener("change", () => {
    selectedStallMixKey = select.value;
    renderStallSalesMix();
  });
}
function describeArc(cx, cy, rOuter, rInner, startAngle, endAngle) {
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
  const outerStart = [cx + rOuter * Math.cos(startAngle), cy + rOuter * Math.sin(startAngle)];
  const outerEnd = [cx + rOuter * Math.cos(endAngle), cy + rOuter * Math.sin(endAngle)];
  const innerStart = [cx + rInner * Math.cos(endAngle), cy + rInner * Math.sin(endAngle)];
  const innerEnd = [cx + rInner * Math.cos(startAngle), cy + rInner * Math.sin(startAngle)];
  return [
    `M ${outerStart[0]} ${outerStart[1]}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${outerEnd[0]} ${outerEnd[1]}`,
    `L ${innerStart[0]} ${innerStart[1]}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${innerEnd[0]} ${innerEnd[1]}`,
    "Z"
  ].join(" ");
}
function renderStallSalesMix() {
  const pie = document.getElementById("stallMixPie");
  const tableBody = document.querySelector("#stallMixTable tbody");
  const label = document.getElementById("stallMixTotalLabel");
  const mix = data.stall_sales_mix || {};
  if (!mix.enabled) {
    document.getElementById("stall-mix").hidden = true;
    return;
  }
  const entity = currentStallMixEntity();
  if (!entity) return;
  const rows = entity.rows || [];
  if (label) label.textContent = `${cleanName(entity.label)}店内营业收入 ${fmtWan(entity.total)}`;

  const w = 760,
    h = 340,
    cx = 218,
    cy = 170,
    rOuter = 122,
    rInner = 68;
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}` });
  const tip = document.createElement("div");
  tip.className = "chart-tooltip";
  let start = -Math.PI / 2;
  rows.forEach((row, index) => {
    const value = Number(row.value || 0);
    const angle = (value / Math.max(entity.total, 1)) * Math.PI * 2;
    const end = start + angle;
    const fill = stallPalette[index % stallPalette.length];
    if (angle > 0.0001) {
      const slice = svg("path", {
        d: describeArc(cx, cy, rOuter, rInner, start, end),
        fill,
        stroke: "#fff",
        "stroke-width": 2,
        style: "cursor:pointer"
      });
      slice.addEventListener("mousemove", (event) => {
        tip.innerHTML = `<strong>${row.name}</strong>${fmtWan(value)}<br>占比：${fmtPct(row.share)}`;
        positionTooltip(tip, pie, event);
      });
      slice.addEventListener("mouseleave", () => {
        tip.style.display = "none";
      });
      root.appendChild(slice);
    }
    start = end;
  });
  root.appendChild(
    svg("text", {
      x: cx,
      y: cy - 4,
      "text-anchor": "middle",
      "font-size": "13",
      fill: "#657386",
      "font-weight": "760"
    })
  ).textContent = cleanName(entity.label);
  root.appendChild(
    svg("text", {
      x: cx,
      y: cy + 24,
      "text-anchor": "middle",
      "font-size": "24",
      fill: "#172033",
      "font-weight": "840"
    })
  ).textContent = fmtWan(entity.total);
  const legendX = 390;
  rows.forEach((row, index) => {
    const y = 42 + index * 25;
    root.appendChild(
      svg("rect", {
        x: legendX,
        y: y - 10,
        width: 11,
        height: 11,
        rx: 2,
        fill: stallPalette[index % stallPalette.length]
      })
    );
    const name =
      String(row.name || "").length > 18 ? `${String(row.name).slice(0, 18)}...` : row.name;
    root.appendChild(
      svg("text", {
        x: legendX + 18,
        y: y,
        "font-size": "12",
        fill: "#344054",
        "font-weight": "700"
      })
    ).textContent = name;
    root.appendChild(
      svg("text", { x: w - 28, y: y, "text-anchor": "end", "font-size": "12", fill: "#657386" })
    ).textContent = fmtPct(row.share);
  });
  pie.innerHTML = "";
  pie.appendChild(root);
  pie.appendChild(tip);

  if (tableBody) {
    tableBody.innerHTML = rows
      .map(
        (row, index) => `
          <tr>
            <td><span class="swatch" data-sample-color="${stallPalette[index % stallPalette.length]}"></span>${row.name}</td>
            <td>${fmtWan(row.value)}</td>
            <td>${fmtPct(row.share)}</td>
            <td>${row.quantity === null || row.quantity === undefined ? "-" : fmtNum(row.quantity)}</td>
          </tr>
        `
      )
      .join("");
  }
}
function currentProductSalesPer10kEntity(panel) {
  const entities = data[panel.dataKey]?.entities || [];
  return (
    entities.find((item) => item.key === selectedProductSalesPer10kKeys[panel.stateKey]) ||
    entities[0]
  );
}
function renderProductSalesPer10kSelector() {
  productSalesPer10kPanels.forEach((panel) => {
    const select = document.getElementById(panel.selectId);
    const input = document.getElementById(panel.searchId);
    if (!select || !input) return;
    const entities = data[panel.dataKey]?.entities || [];
    select.innerHTML = entities
      .map((item) => `<option value="${item.key}">${cleanName(item.label)}</option>`)
      .join("");
    if (!entities.some((item) => item.key === selectedProductSalesPer10kKeys[panel.stateKey])) {
      selectedProductSalesPer10kKeys[panel.stateKey] = entities[0]?.key || "__all__";
    }
    select.value = selectedProductSalesPer10kKeys[panel.stateKey];
    select.addEventListener("change", () => {
      selectedProductSalesPer10kKeys[panel.stateKey] = select.value;
      renderProductSalesPer10kPanel(panel);
    });
    input.addEventListener("input", () => renderProductSalesPer10kPanel(panel));
  });
}
function renderProductSalesPer10kPanel(panel) {
  const body = document.querySelector(`#${panel.tableId} tbody`);
  const input = document.getElementById(panel.searchId);
  const status = document.getElementById(panel.statusId);
  const metric = data[panel.dataKey] || {};
  if (!body || !status) return;
  if (!metric.enabled) {
    body.innerHTML = `<tr><td colspan="5">${metric.meta?.reason || "产品万元销量需要同时提供菜品主题数据和菜品库。"}</td></tr>`;
    status.textContent = "未启用";
    return;
  }
  const entity = currentProductSalesPer10kEntity(panel);
  if (!entity || entity.available === false) {
    body.innerHTML = `<tr><td colspan="5">${entity?.unavailable_reason || `当前区间${panel.denominatorLabel}不可用，无法计算。`}</td></tr>`;
    status.textContent = "不可计算";
    return;
  }
  const query = String(input?.value || "")
    .trim()
    .toLocaleLowerCase("zh-CN");
  const allRows = entity?.rows || [];
  const rows = query
    ? allRows.filter((row) =>
        String(row.search_names || row.name || "")
          .toLocaleLowerCase("zh-CN")
          .includes(query)
      )
    : allRows.slice(0, 10);
  status.textContent = query
    ? `找到 ${rows.length} 项 · 当前区间${panel.denominatorLabel} ${fmtWan(entity?.total_denominator || 0)}`
    : `Top 10 · 当前区间${panel.denominatorLabel} ${fmtWan(entity?.total_denominator || 0)}`;
  body.innerHTML = rows.length
    ? rows
        .map(
          (row) => `<tr>
        <td>${row.name}</td>
        <td>${row.sales_class}</td>
        <td>${row.stall}</td>
        <td>${fmtNum(row.quantity)} 份</td>
        <td>${row.units_per_10k === null || row.units_per_10k === undefined ? "<b>N/A</b>" : `<b>${fmtNum(row.units_per_10k)}</b> 份/万元`}</td>
      </tr>`
        )
        .join("")
    : '<tr><td colspan="5">没有匹配的产品</td></tr>';
}
function renderProductSalesPer10k() {
  const enabled = productSalesPer10kPanels.some((panel) => data[panel.dataKey]?.enabled);
  document.getElementById("product-sales-per-10k").hidden = !enabled;
  if (!enabled) return;
  productSalesPer10kPanels.forEach(renderProductSalesPer10kPanel);
}
function renderDriverBar() {
  const groups = segmentGroups
    .map((group) => ({
      label: group.label,
      rows: (group.rows || []).filter((r) => r.segment === "问题门店").slice(0, 4)
    }))
    .filter((group) => group.rows.length);
  const fallbackRows = stores.filter((r) => r.segment === "问题门店").slice(0, 6);
  const renderGroups = groups.length
    ? groups
    : [{ label: "问题门店", rows: fallbackRows.length ? fallbackRows : stores.slice(-6) }];
  const el = document.getElementById("driverBar");
  const totalRows = renderGroups.reduce((sum, group) => sum + group.rows.length, 0);
  const w = 1120,
    h = Math.max(430, totalRows * 76 + renderGroups.length * 42 + 70),
    left = 180,
    mid = 575,
    right = 120;
  const vals = renderGroups.flatMap((group) =>
    group.rows.flatMap((r) => [
      Number(r.wow_order_volume_contribution || 0),
      Number(r.wow_aov_contribution || 0),
      Number(r.wow_dine_in_delta || 0),
      Number(r.wow_delivery_delta || 0)
    ])
  );
  const max = Math.max(...vals.map((v) => Math.abs(v)), 1);
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}` });
  [
    ["量贡献", colors.blue, 0],
    ["价贡献", colors.teal, 72],
    ["堂食变化", colors.green, 144],
    ["外卖变化", colors.amber, 232]
  ].forEach(([label, color, xOff]) => {
    root.appendChild(
      svg("rect", { x: left + xOff, y: 16, width: 12, height: 12, rx: 2, fill: color })
    );
    root.appendChild(
      svg("text", { x: left + xOff + 18, y: 27, "font-size": "12", fill: "#657386" })
    ).textContent = label;
  });
  root.appendChild(svg("line", { x1: mid, y1: 46, x2: mid, y2: h - 26, stroke: "#d9e2ea" }));
  let y = 58;
  renderGroups.forEach((group) => {
    root.appendChild(
      svg("text", {
        x: left - 8,
        y: y + 16,
        "text-anchor": "end",
        "font-size": "12",
        fill: "#172033",
        "font-weight": "800"
      })
    ).textContent = `${group.label}问题`;
    y += 28;
    group.rows.forEach((r, i) => {
      if (i > 0) {
        root.appendChild(
          svg("line", {
            x1: left,
            y1: y - 14,
            x2: w - right,
            y2: y - 14,
            stroke: "#d9e2ea",
            "stroke-dasharray": "5 6"
          })
        );
      }
      root.appendChild(
        svg("text", {
          x: left - 8,
          y: y + 25,
          "text-anchor": "end",
          "font-size": "12",
          fill: "#344054"
        })
      ).textContent = cleanName(r["门店名称"]);
      [
        [Number(r.wow_order_volume_contribution || 0), colors.blue, 0],
        [Number(r.wow_aov_contribution || 0), colors.teal, 16],
        [Number(r.wow_dine_in_delta || 0), colors.green, 32],
        [Number(r.wow_delivery_delta || 0), colors.amber, 48]
      ].forEach(([v, c, off]) => {
        const bw = (Math.abs(v) / max) * 360;
        const x = v >= 0 ? mid : mid - bw;
        root.appendChild(
          svg("rect", { x, y: y + off, width: bw, height: 12, rx: 2, fill: c, opacity: 0.9 })
        );
        root.appendChild(
          svg("text", {
            x: v >= 0 ? x + bw + 7 : x - 7,
            y: y + off + 10,
            "text-anchor": v >= 0 ? "start" : "end",
            "font-size": "11",
            fill: "#657386"
          })
        ).textContent = fmtWan(v);
      });
      y += 76;
    });
    y += 14;
  });
  el.innerHTML = "";
  el.appendChild(root);
}
function renderTable() {
  const body = document.querySelector("#storeTable tbody");
  const tagClass = (segment) =>
    segment === "明星门店"
      ? "star"
      : segment === "问题门店"
        ? "problem"
        : segment === "高基盘承压"
          ? "pressure"
          : segment === "成长观察"
            ? "growth"
            : "";
  const rows = stores
    .map(
      (r) => `<tr>
        <td>${cleanName(r["门店名称"])}</td>
        <td>${r.store_size || "未分组"}</td>
        <td><span class="tag ${tagClass(r.segment)}">${r.segment}</span></td>
        <td>${fmtWan(r.current_net_revenue)}</td>
        <td>${fmtPct(r.wow_net_revenue_pct)}</td>
        <td>${fmtPct(r.yoy_net_revenue_pct)}</td>
        <td>${fmtWan(r.current_dine_in_revenue)}</td>
        <td>${fmtWan(r.current_delivery_revenue)}</td>
        <td>${fmtNum(r.current_customer_count)}</td>
        <td>${fmtNum(r.current_consumed_tables)}</td>
        <td>${fmtYuan(r.current_post_discount_aov)}</td>
        <td>${fmtPct(r.current_discount_rate)}</td>
        <td>${r.top_stall_signal || ""}</td>
        <td>${r.top_daypart_signal || ""}</td>
        <td>${r.top_negative_factor || r.segment_reason || ""}</td>
      </tr>`
    )
    .join("");
  body.innerHTML = rows;
  document.querySelectorAll("#storeTable th[data-key]").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      stores.sort((a, b) => {
        const av = a[key],
          bv = b[key];
        const na = Number(av),
          nb = Number(bv);
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return nb - na;
        return String(av || "").localeCompare(String(bv || ""), "zh-CN");
      });
      renderTable();
    });
  });
}
function renderActions() {
  document.getElementById("actionList").innerHTML =
    `<div class="card" data-sample-style="9"><b>先核查两店，再保留恢复做法</b><p>门店 E午晚餐合计少4.11万元：先查跨餐段营业、接单和重点菜供应，共同瓶颈先修复；条件正常再查订单结构。</p><p>门店 G堂食同比少8.05万元：先查午晚餐日常订单来源与接待，主食和羊肉同步核查可售。</p><p>门店 B午晚餐恢复、整体折扣收窄：维持现有流程一周，确认普通周稳定后再选一项做法复制。</p><a href="#business-advisory">查看逐店判断、责任角色与复盘条件</a></div>`;
}
function fmtDeltaWan(v) {
  if (v === null || v === undefined || v === "") return "N/A";
  const value = Number(v || 0);
  if (!Number.isFinite(value)) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${fmtWan(value)}`;
}
function dishList(rows) {
  if (!rows || !rows.length) return '<span class="label">暂无代表菜品</span>';
  return rows
    .map(
      (row) =>
        `<span class="tag" data-sample-style="10">${row["菜品名称"]} ${fmtDeltaWan(row.income_delta)}</span>`
    )
    .join("");
}
function renderStallAttribution() {
  const root = document.getElementById("stallAttribution");
  const stall = data.stall_attribution || {};
  if (!stall.enabled) {
    document.getElementById("stall-drivers").hidden = true;
    return;
  }
  const match = stall.match_summary || {};
  const drivers = stall.drivers || [];
  const yoyDrivers = stall.yoy_drivers || [];
  const basis = (stall.meta && stall.meta.basis) || "菜品主题数据“菜品收入” × 菜品库“基础分类”。";
  const coverage = (stall.meta && stall.meta.period_coverage) || {};
  const missing = ["current", "previous", "yoy"]
    .filter((key) => !(coverage[key] && Number(coverage[key].rows || 0) > 0))
    .map((key) => coverage[key]?.label || key);
  const coverageNote = missing.length
    ? `<div class="callout" data-sample-style="11">部分期间菜品数据不足，相关档口和菜品变化暂不显示。</div>`
    : "";
  const rowHtml = (rows) =>
    rows
      .map(
        (row) => `<tr>
        <td>${cleanName(row["门店名称"])}</td>
        <td>${row.basis}</td>
        <td>${row.top_negative_stall || ""}</td>
        <td>${fmtDeltaWan(row.top_negative_income_delta)}</td>
        <td>${dishList(row.negative_dishes)}</td>
        <td>${row.top_positive_stall || ""}</td>
        <td>${fmtDeltaWan(row.top_positive_income_delta)}</td>
        <td>${dishList(row.positive_dishes)}</td>
      </tr>`
      )
      .join("");
  root.innerHTML = `
        ${coverageNote}
        <div class="grid-3">
          <div class="card"><div class="label">菜品行匹配率</div><div class="value">${fmtPct(match.match_rate)}</div><div class="foot">关联名称补齐 ${fmtNum(match.linked_name_rescued_rows)} / 未匹配 ${fmtNum(match.unmatched_rows)} / 重名 ${fmtNum(match.ambiguous_rows)}</div></div>
          <div class="card"><div class="label">菜品库规模</div><div class="value">${fmtNum(match.catalog_rows)}</div><div class="foot">基础分类档口 ${fmtNum(match.catalog_stall_count)} 个</div></div>
          <div class="card"><div class="label">归因口径</div><div class="value">环比 + 同比</div><div class="foot">按菜品收入变化排序</div></div>
        </div>
        <div class="callout" data-sample-style="8">${basis}</div>
        <div class="panel full-row" data-sample-style="8">
          <div class="panel-head"><h3>环比档口归因：门店主要变化</h3><span class="label">负向档口 / 正向档口 / 代表菜品</span></div>
          <div class="table-wrap"><table aria-label="经营事实表"><thead><tr><th scope="col">门店</th><th scope="col">口径</th><th scope="col">负向档口</th><th scope="col">负向变化</th><th scope="col">负向代表菜品</th><th scope="col">正向档口</th><th scope="col">正向变化</th><th scope="col">正向代表菜品</th></tr></thead><tbody>${rowHtml(drivers)}</tbody></table></div>
        </div>
        <div class="panel full-row" data-sample-style="8">
          <div class="panel-head"><h3>同比档口归因</h3><span class="label">用于核对同品结构与持续变化</span></div>
          <div class="table-wrap"><table aria-label="经营事实表"><thead><tr><th scope="col">门店</th><th scope="col">口径</th><th scope="col">负向档口</th><th scope="col">负向变化</th><th scope="col">负向代表菜品</th><th scope="col">正向档口</th><th scope="col">正向变化</th><th scope="col">正向代表菜品</th></tr></thead><tbody>${rowHtml(yoyDrivers)}</tbody></table></div>
        </div>`;
}
function slotList(rows) {
  if (!rows || !rows.length) return '<span class="label">无明显变化</span>';
  return rows
    .map(
      (row) =>
        `<span class="tag" data-sample-style="10">${row["餐段"]} ${row["时段"]} ${fmtDeltaWan(row.net_revenue_delta)}</span>`
    )
    .join("");
}
function renderDaypartAttribution() {
  const root = document.getElementById("daypartAttribution");
  const daypart = data.daypart_attribution || {};
  if (!daypart.enabled) {
    document.getElementById("daypart-drivers").hidden = true;
    return;
  }
  const drivers = daypart.drivers || [];
  const yoyDrivers = daypart.yoy_drivers || [];
  const basis = (daypart.meta && daypart.meta.basis) || "营业分组表“时段”字段。";
  const rowHtml = (rows) =>
    rows
      .map(
        (row) => `<tr>
        <td>${cleanName(row["门店名称"])}</td>
        <td>${row.basis}</td>
        <td>${slotList(row.negative_slots)}</td>
        <td>${fmtDeltaWan(row.top_negative_net_revenue_delta)}</td>
        <td>${slotList(row.positive_slots)}</td>
        <td>${fmtDeltaWan(row.top_positive_net_revenue_delta)}</td>
      </tr>`
      )
      .join("");
  root.innerHTML = `
        <div class="grid-3">
          <div class="card"><div class="label">归因维度</div><div class="value">餐段 × 时段</div><div class="foot">来自营业分组表</div></div>
          <div class="card"><div class="label">归因口径</div><div class="value">环比 + 同比</div><div class="foot">按订单营业收入变化排序</div></div>
          <div class="card"><div class="label">展示规则</div><div class="value">Top 3</div><div class="foot">每店负向 / 正向时段</div></div>
        </div>
        <div class="callout" data-sample-style="8">${basis}</div>
        <div class="panel full-row" data-sample-style="8">
          <div class="panel-head"><h3>环比时段归因：门店主要变化</h3><span class="label">负向时段 / 正向时段</span></div>
          <div class="table-wrap"><table aria-label="经营事实表"><thead><tr><th scope="col">门店</th><th scope="col">口径</th><th scope="col">负向时段 Top 3</th><th scope="col">最大负向变化</th><th scope="col">正向时段 Top 3</th><th scope="col">最大正向变化</th></tr></thead><tbody>${rowHtml(drivers)}</tbody></table></div>
        </div>
        <div class="panel full-row" data-sample-style="8">
          <div class="panel-head"><h3>同比时段归因</h3><span class="label">用于核对同品结构与持续变化</span></div>
          <div class="table-wrap"><table aria-label="经营事实表"><thead><tr><th scope="col">门店</th><th scope="col">口径</th><th scope="col">负向时段 Top 3</th><th scope="col">最大负向变化</th><th scope="col">正向时段 Top 3</th><th scope="col">最大正向变化</th></tr></thead><tbody>${rowHtml(yoyDrivers)}</tbody></table></div>
        </div>`;
}
function hourlyEntity() {
  const entities = data.hourly_revenue_entities || [
    { key: "__all__", label: "全体门店", rows: [] }
  ];
  return entities.find((item) => item.key === selectedHourlyKey) || entities[0];
}
function renderHourlySelector() {
  const select = document.getElementById("hourlyStoreSelect");
  const entities = data.hourly_revenue_entities || [
    { key: "__all__", label: "全体门店", rows: [] }
  ];
  select.innerHTML = entities
    .map((item) => `<option value="${item.key}">${cleanName(item.label)}</option>`)
    .join("");
  select.value = selectedHourlyKey;
  select.addEventListener("change", () => {
    selectedHourlyKey = select.value;
    renderHourlyRevenueBar();
  });
}
function renderHourlyRevenueBar() {
  const el = document.getElementById("hourlyRevenueBar");
  const entity = hourlyEntity();
  const rows = entity.rows || [];
  if (!rows.some((row) => Number(row.net_revenue || 0))) {
    document.getElementById("dayparts").hidden = true;
    return;
  }
  const isAllStores = entity.key === "__all__";
  document.getElementById("hourlyRevenueLabel").textContent =
    `本周，${isAllStores ? "整体" : cleanName(entity.label)}业务收入（万元）`;
  const w = 1120,
    h = 350,
    left = 74,
    right = 34,
    top = 34,
    bottom = 62;
  const max = Math.max(...rows.map((r) => Number(r.net_revenue || 0)), 1);
  const yMax = Math.ceil(max / 10000) * 10000 || 1;
  const yScale = (v) => h - bottom - (Number(v || 0) / yMax) * (h - top - bottom);
  const plotW = w - left - right;
  const slot = plotW / 24;
  const barW = Math.max(12, Math.min(28, slot * 0.64));
  const root = svg("svg", { viewBox: `0 0 ${w} ${h}` });
  const tip = document.createElement("div");
  tip.className = "chart-tooltip";
  const showTip = (event, row) => {
    tip.innerHTML = `<strong>${Number(row.hour)}点</strong>业务收入：${fmtWan(row.net_revenue)}`;
    positionTooltip(tip, el, event);
  };
  const hideTip = () => {
    tip.style.display = "none";
  };
  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    const value = yMax * t;
    const y = yScale(value);
    root.appendChild(svg("line", { x1: left, y1: y, x2: w - right, y2: y, stroke: "#e6edf3" }));
    root.appendChild(
      svg("text", {
        x: left - 10,
        y: y + 4,
        "text-anchor": "end",
        "font-size": "11",
        fill: "#657386"
      })
    ).textContent = fmtWan(value);
  });
  root.appendChild(svg("line", { x1: left, y1: top, x2: left, y2: h - bottom, stroke: "#9aa7b5" }));
  root.appendChild(
    svg("line", { x1: left, y1: h - bottom, x2: w - right, y2: h - bottom, stroke: "#9aa7b5" })
  );
  rows.forEach((row, i) => {
    const value = Number(row.net_revenue || 0);
    const x = left + i * slot + (slot - barW) / 2;
    const y = yScale(value);
    const height = h - bottom - y;
    const bar = svg("rect", {
      x,
      y,
      width: barW,
      height: Math.max(1, height),
      rx: 4,
      fill: colors.teal,
      opacity: 0.9,
      style: "cursor:pointer"
    });
    const title = svg("title", {});
    title.textContent = `${Number(row.hour)}点 业务收入：${fmtWan(value)}`;
    bar.appendChild(title);
    bar.addEventListener("mousemove", (event) => showTip(event, row));
    bar.addEventListener("mouseleave", hideTip);
    root.appendChild(bar);
    root.appendChild(
      svg("text", {
        x: x + barW / 2,
        y: h - 38,
        "text-anchor": "middle",
        "font-size": "10",
        fill: "#657386"
      })
    ).textContent = `${Number(row.hour)}点`;
  });
  const peak = rows.reduce(
    (best, row) => (Number(row.net_revenue || 0) > Number(best.net_revenue || 0) ? row : best),
    rows[0] || { hour: "00", net_revenue: 0 }
  );
  root.appendChild(
    svg("text", { x: left, y: 18, "font-size": "12", fill: "#657386", "font-weight": "700" })
  ).textContent = "业务收入（万元）";
  root.appendChild(
    svg("text", { x: w - right, y: 18, "text-anchor": "end", "font-size": "11", fill: "#657386" })
  ).textContent = `峰值：${Number(peak.hour)}点 ${fmtWan(peak.net_revenue)}`;
  el.innerHTML = "";
  el.appendChild(root);
  el.appendChild(tip);
}
function renderGaps() {
  const messages = data.data_gaps || [];
  const notice = document.getElementById("missingDataNotice");
  if (messages.length) {
    notice.hidden = false;
    notice.innerHTML = `<b>数据提示：</b>${messages.join("；")}`;
  }
  document.getElementById("dataGaps").hidden = true;
  const hideSection = (id) => {
    const section = document.getElementById(id);
    if (section) section.hidden = true;
    const link = document.querySelector(`.nav a[href="#${id}"]`);
    if (link) link.hidden = true;
  };
  const availability = data.availability || {};
  if (!availability.current) {
    document.querySelector(".hero .summary").hidden = true;
    [
      "summary",
      "ranking",
      "stores",
      "channels",
      "stall-mix",
      "product-sales-per-10k",
      "drivers",
      "stall-drivers",
      "daypart-drivers",
      "dayparts"
    ].forEach(hideSection);
    return;
  }
  if (!availability.trend) document.getElementById("trend").closest(".panel").hidden = true;
  if (!availability.channels) hideSection("channels");
  if (!data.stall_sales_mix?.enabled) hideSection("stall-mix");
  if (
    ![data.product_sales_per_10k_order_revenue, data.product_sales_per_10k_gross_sales].some(
      (panel) => panel?.enabled
    )
  )
    hideSection("product-sales-per-10k");
  if (!data.stall_attribution?.enabled) hideSection("stall-drivers");
  if (!data.daypart_attribution?.enabled) hideSection("daypart-drivers");
  if (!availability.dayparts) hideSection("dayparts");
}
renderMeta();
renderKpis();
renderRules();
renderBucketedRevenueRanking();
renderGrowthBar();
renderBucketedScatter();
renderTrendSelector();
renderTrend();
renderTable();
renderMixBars();
renderPlatformBars();
renderStallMixSelector();
renderStallSalesMix();
renderProductSalesPer10kSelector();
renderProductSalesPer10k();
renderDriverBar();
renderActions();
renderStallAttribution();
renderDaypartAttribution();
renderHourlySelector();
renderHourlyRevenueBar();
renderGaps();

// Forward Escape from the isolated report to its reader.
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && window.parent !== window) {
    window.parent.postMessage({ type: "smedc-report:close" }, "*");
  }
});
