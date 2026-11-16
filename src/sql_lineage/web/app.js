/* Single-page viewer for the offline lineage export.
 * No framework, no network calls beyond fetching /api/lineage once.
 */
"use strict";

let DATA = null;
let selectedBlockId = null;
let selectedBase = null;

const $ = (id) => document.getElementById(id);

async function init() {
  const resp = await fetch("api/lineage", { cache: "no-store" });
  if (!resp.ok) {
    document.body.innerHTML = `<p style="padding:24px">无法加载 lineage 数据 (${resp.status})。请先运行导出。</p>`;
    return;
  }
  DATA = await resp.json();
  renderStats();
  renderBlockList();
  renderBaseList();
  renderUnresolved();
  bindTabs();
  bindFilters();

  const firstBlock = DATA.blocks.find((b) => b.parent_block_id === null);
  if (firstBlock) selectBlock(firstBlock.block_id);
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      btn.classList.add("active");
      $(`view-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

function bindFilters() {
  $("block-filter").addEventListener("input", renderBlockList);
  $("base-filter").addEventListener("input", renderBaseList);
}

function renderStats() {
  const files = new Set(DATA.files.map((f) => f.file)).size;
  const blocks = DATA.blocks.length;
  const outputs = DATA.blocks.reduce((n, b) => n + b.output_columns.length, 0);
  const unresolved = DATA.unresolved.length;
  $("stats").innerHTML =
    `<span>文件 <b>${files}</b></span>` +
    `<span>查询块 <b>${blocks}</b></span>` +
    `<span>输出列 <b>${outputs}</b></span>` +
    `<span>原始字段 <b>${DATA.base_columns.length}</b></span>` +
    `<span>未解析 <b style="color:var(--danger)">${unresolved}</b></span>`;
  const badge = $("unresolved-badge");
  badge.textContent = unresolved;
  badge.classList.toggle("hidden", unresolved === 0);
}

// ---------------------------------------------------------------------------
// Forward view
// ---------------------------------------------------------------------------

function renderBlockList() {
  const filter = $("block-filter").value.trim().toLowerCase();
  const ul = $("block-list");
  ul.innerHTML = "";
  DATA.blocks
    .filter((b) => b.parent_block_id === null)
    .filter((b) => {
      if (!filter) return true;
      const hay = [
        b.file,
        b.name,
        b.block_id,
        ...b.output_columns.map((o) => o.name),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(filter);
    })
    .forEach((b) => {
      const li = document.createElement("li");
      li.dataset.blockId = b.block_id;
      if (b.block_id === selectedBlockId) li.classList.add("selected");
      const unres = b.unresolved.length
        ? ` · <span style="color:var(--danger)">${b.unresolved.length} 未解析</span>`
        : "";
      li.innerHTML =
        `<div class="title">${escapeHtml(shortName(b))}` +
        (b.unsupported ? '<span class="flag-unsupported">不支持</span>' : "") +
        `</div>` +
        `<div class="meta">${escapeHtml(b.file)} · ${b.kind} · ` +
        `${b.output_columns.length} 列${unres}</div>`;
      li.addEventListener("click", () => selectBlock(b.block_id));
      ul.appendChild(li);
    });
}

function shortName(block) {
  return block.name && !block.name.includes("#") ? block.name : block.block_id;
}

function selectBlock(blockId) {
  selectedBlockId = blockId;
  document
    .querySelectorAll("#block-list li")
    .forEach((li) => li.classList.toggle("selected", li.dataset.blockId === blockId));
  const block = DATA.blocks.find((b) => b.block_id === blockId);
  $("forward-empty").classList.add("hidden");
  const detail = $("forward-detail");
  detail.classList.remove("hidden");

  const head =
    `<h2>${escapeHtml(shortName(block))}<span class="kind-tag">${block.kind}</span></h2>` +
    `<div class="crumbs">${escapeHtml(block.file)}` +
    (block.location ? ` · 行 ${block.location.line}:${block.location.col}` : "") +
    `</div>` +
    (block.unsupported
      ? `<div class="pill" style="margin-bottom:12px">该块包含不支持的递归查询，未计算血缘</div>`
      : "");

  const outputs = block.output_columns
    .map((o) => renderOutputCard(o))
    .join("");

  const blockLevel = block.block_predicate_deps.length
    ? `<h3>块级过滤 / 连接 / 分组依赖（影响全部输出行）</h3>` +
      `<ul class="tree root">${block.block_predicate_deps.map(renderNode).join("")}</ul>`
    : "";

  detail.innerHTML = head + outputs + blockLevel + renderBlockUnresolved(block);
}

function renderOutputCard(output) {
  const tags = [];
  if (output.is_aggregate) tags.push('<span class="tag agg">聚合</span>');
  if (output.is_expanded_from_star) tags.push('<span class="tag star">星号展开</span>');
  if (output.is_constant) tags.push('<span class="tag star">常量表达式</span>');
  const valueTree = output.lineage.length
    ? `<ul class="tree root">${output.lineage.map(renderNode).join("")}</ul>`
    : `<div class="empty" style="text-align:left;padding:6px 0">无字段来源（常量 / 字面量表达式）</div>`;
  const predTree = output.predicate_deps.length
    ? `<div class="section-predicate"><span class="tag predicate">仅影响筛选/连接/分组</span>` +
      `<ul class="tree root" style="margin-top:6px">${output.predicate_deps
        .map(renderNode)
        .join("")}</ul></div>`
    : "";
  return (
    `<div class="output-card">` +
    `<div class="output-head">` +
    `<span class="output-name">#${output.ordinal} ${escapeHtml(output.name)}</span>` +
    `<span class="output-expr">${escapeHtml(output.expression)}</span>` +
    `<span class="output-tags">${tags.join("")}</span>` +
    `</div>` +
    valueTree +
    predTree +
    `</div>`
  );
}

function renderNode(node) {
  const cls = node.unresolved
    ? "unresolved"
    : node.kind === "predicate"
    ? "predicate"
    : node.table
    ? "base"
    : "";
  const label = node.table
    ? `<b>${escapeHtml(node.table)}.${escapeHtml(node.column)}</b>`
    : node.block
    ? `${escapeHtml(shortBlock(node.block))}<b>.${escapeHtml(node.column)}</b>`
    : `<b>${escapeHtml(node.column)}</b>`;
  const transform = node.transform
    ? `<span class="transform">${escapeHtml(node.transform)}</span>`
    : "";
  const loc = node.location
    ? `<span class="loc">${escapeHtml(node.location.file)}:${node.location.line}:${node.location.col}</span>`
    : "";
  const unres = node.unresolved
    ? `<span class="unres-msg">⚠ ${escapeHtml(node.unresolved.kind)} — ${escapeHtml(
        node.unresolved.message
      )}</span>`
    : "";
  const children = node.children.length
    ? `<ul class="tree">${node.children.map(renderNode).join("")}</ul>`
    : "";
  return (
    `<li><span class="node ${cls}">` +
    `<span class="role ${node.kind}">${node.kind === "value" ? "值来源" : "条件"}</span>` +
    label + transform + loc + unres +
    `</span>${children}</li>`
  );
}

function renderBlockUnresolved(block) {
  if (!block.unresolved.length) return "";
  return (
    `<h3 style="color:var(--danger)">本块未解析项 (${block.unresolved.length})</h3>` +
    `<table><thead><tr><th>类型</th><th>说明</th><th>位置</th><th>片段</th></tr></thead><tbody>` +
    block.unresolved
      .map(
        (u) =>
          `<tr><td class="kind-cell"><span class="pill">${u.kind}</span></td>` +
          `<td>${escapeHtml(u.message)}</td>` +
          `<td>${u.location ? `${escapeHtml(u.location.file)}:${u.location.line}:${u.location.col}` : ""}</td>` +
          `<td class="snippet">${u.location ? escapeHtml(u.location.snippet) : ""}</td></tr>`
      )
      .join("") +
    `</tbody></table>`
  );
}

// ---------------------------------------------------------------------------
// Reverse view
// ---------------------------------------------------------------------------

function renderBaseList() {
  const filter = $("base-filter").value.trim().toLowerCase();
  const ul = $("base-list");
  ul.innerHTML = "";
  DATA.base_columns
    .map((c) => `${c.table}.${c.column}`)
    .filter((name) => !filter || name.toLowerCase().includes(filter))
    .forEach((name) => {
      const li = document.createElement("li");
      li.dataset.base = name;
      if (name === selectedBase) li.classList.add("selected");
      const impact = DATA.impacts[name];
      const v = impact ? impact.value_impacts.length : 0;
      const p = impact ? impact.predicate_impacts.length : 0;
      li.innerHTML =
        `<div class="title">${escapeHtml(name)}</div>` +
        `<div class="meta">值影响 <b style="color:var(--value)">${v}</b> · ` +
        `条件影响 <b style="color:var(--predicate)">${p}</b></div>`;
      li.addEventListener("click", () => selectBase(name));
      ul.appendChild(li);
    });
}

function selectBase(name) {
  selectedBase = name;
  document
    .querySelectorAll("#base-list li")
    .forEach((li) => li.classList.toggle("selected", li.dataset.base === name));
  const impact = DATA.impacts[name];
  $("reverse-empty").classList.add("hidden");
  const detail = $("reverse-detail");
  detail.classList.remove("hidden");
  if (!impact) {
    detail.innerHTML = `<div class="empty">该字段没有出现在任何已分析查询中</div>`;
    return;
  }
  detail.innerHTML =
    `<h2>${escapeHtml(name)}</h2>` +
    renderImpactGroup("值来源影响（字段值流入这些输出）", impact.value_impacts, "value") +
    renderImpactGroup(
      "条件影响（仅参与筛选 / 连接 / 分组 / 窗口）",
      impact.predicate_impacts,
      "predicate"
    );
}

function renderImpactGroup(title, paths, cls) {
  if (!paths.length) {
    return `<h3>${escapeHtml(title)}</h3><div class="empty" style="text-align:left">无</div>`;
  }
  return (
    `<div class="impact-group"><h3>${escapeHtml(title)} (${paths.length})</h3>` +
    paths
      .map((p) => {
        const hopChain = p.hops
          .map((h, i) => {
            const label = h.table
              ? `${escapeHtml(h.table)}.${escapeHtml(h.column)}`
              : h.block
              ? `${escapeHtml(shortBlock(h.block))}.${escapeHtml(h.column)}`
              : escapeHtml(h.column);
            const loc = h.location
              ? `<span class="loc">${escapeHtml(h.location.file)}:${h.location.line}</span>`
              : "";
            return `<li><span class="node ${h.kind === "predicate" ? "predicate" : "base"}">` +
              `<span class="role ${h.kind}">${h.kind === "value" ? "值" : "条件"}</span>` +
              label +
              (h.transform ? ` <span class="transform">${escapeHtml(h.transform)}</span>` : "") +
              loc + `</span></li>`;
          })
          .join("");
        return (
          `<div class="impact-item ${cls}">` +
          `<div class="head"><span class="block">${escapeHtml(shortBlock(p.block_id))}</span>` +
          `<span class="col">→ 输出列 #${p.output_ordinal} ${escapeHtml(p.output_column)}</span>` +
          (p.output_location
            ? `<span class="loc">${escapeHtml(p.output_location.file)}:${p.output_location.line}:${p.output_location.col}</span>`
            : "") +
          `</div>` +
          `<ul class="tree root" style="margin-top:8px">${hopChain}</ul>` +
          `</div>`
        );
      })
      .join("") +
    `</div>`
  );
}

function shortBlock(blockId) {
  const b = DATA.blocks.find((x) => x.block_id === blockId);
  return b ? shortName(b) : blockId;
}

// ---------------------------------------------------------------------------
// Unresolved view
// ---------------------------------------------------------------------------

function renderUnresolved() {
  const host = $("unresolved-detail");
  if (!DATA.unresolved.length) {
    host.innerHTML = `<div class="empty">没有未解析项，所有引用都已落到具体表字段或明确的常量表达式。</div>`;
    return;
  }
  host.innerHTML =
    `<table style="margin:16px 24px;width:calc(100% - 48px)">` +
    `<thead><tr><th>类型</th><th>说明</th><th>位置</th><th>SQL 片段</th></tr></thead><tbody>` +
    DATA.unresolved
      .map(
        (u) =>
          `<tr><td class="kind-cell"><span class="pill">${u.kind}</span></td>` +
          `<td>${escapeHtml(u.message)}${u.block_id ? `<div class="meta">${escapeHtml(u.block_id)}</div>` : ""}</td>` +
          `<td>${u.location ? `${escapeHtml(u.location.file)}:${u.location.line}:${u.location.col}` : ""}</td>` +
          `<td class="snippet">${u.location ? escapeHtml(u.location.snippet) : ""}</td></tr>`
      )
      .join("") +
    `</tbody></table>`;
}

// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

init().catch((err) => {
  document.body.innerHTML = `<p style="padding:24px;color:var(--danger)">加载失败: ${escapeHtml(
    err.message
  )}</p>`;
});
