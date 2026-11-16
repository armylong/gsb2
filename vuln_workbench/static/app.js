/* 漏洞复现证据工作台前端 —— 纯原生 JS, 无外部依赖, 无任何出站请求。 */
"use strict";

const state = {
  data: null,
  selectedFileId: null,
  maskOn: true,
  editingAnnotationId: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const resp = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json;
}

let toastTimer = null;
function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3500);
}

// ---------------------------------------------------------------------------
// 数据加载
// ---------------------------------------------------------------------------

async function refresh() {
  state.data = await api("/api/state");
  state.maskOn = state.data.mask_settings.hide_by_default;
  $("#mask-toggle").checked = state.maskOn;
  $("#hide-default").checked = state.data.mask_settings.hide_by_default;
  $("#project-name").value = state.data.name || "";
  $("#project-path").textContent = state.data.current_path
    ? `📄 ${state.data.current_path}` : "(尚未保存)";
  renderTree();
  renderCorrelations();
  renderAnnotations();
  renderMaskRules();
  renderOps();
  renderDiffSelectors();
  if (state.selectedFileId) renderFile(state.selectedFileId);
}

// ---------------------------------------------------------------------------
// 左栏: 包树 + 关联
// ---------------------------------------------------------------------------

const KIND_LABEL = {
  request: "请求", response: "响应", log: "日志",
  config: "配置", note: "说明", other: "其他",
};

function renderTree() {
  const box = $("#package-tree");
  if (!state.data.packages.length) {
    box.innerHTML = `<div class="muted" style="padding:10px">暂无复现包, 点击上方「导入复现包」。<br><br>
      支持选择本机目录或 zip 路径 (服务端本地读取, 不上传文件)。</div>`;
    return;
  }
  const filesById = Object.fromEntries(state.data.files.map((f) => [f.id, f]));
  box.innerHTML = state.data.packages.map((pkg) => {
    const files = pkg.file_ids.map((id) => filesById[id]).filter(Boolean);
    const rows = files.map((f) => {
      const bad = f.parse.status === "fallback" || f.parse.status === "binary"
        || f.parse.status === "truncated";
      return `<div class="file-node ${bad ? "bad" : ""} ${
        state.selectedFileId === f.id ? "active" : ""}" data-file="${f.id}">
        <span class="kind">${KIND_LABEL[f.kind] || f.kind}</span>
        <span class="fname" title="${esc(f.rel_path)}">${esc(f.rel_path)}</span>
        ${f.duplicate_of ? '<span class="dup-dot" title="重复证据">●</span>' : ""}
      </div>`;
    }).join("");
    return `<div class="pkg-node">📦 ${esc(pkg.name)}
      <span class="muted">(${files.length})</span></div>${rows}`;
  }).join("");
  box.querySelectorAll(".file-node").forEach((node) => {
    node.addEventListener("click", () => renderFile(node.dataset.file));
  });
}

function renderCorrelations() {
  const box = $("#corr-list");
  const groups = state.data.correlations || [];
  if (!groups.length) {
    box.innerHTML = `<div class="muted" style="padding:6px">暂无跨文件关联实体。</div>`;
    return;
  }
  const typeLabel = { ip: "地址", url: "URL", timestamp: "时间", id: "编号" };
  box.innerHTML = groups.slice(0, 100).map((g) => `
    <div class="corr-group" data-files='${esc(JSON.stringify(g.file_ids))}'>
      <span class="corr-type">${typeLabel[g.entity_type] || g.entity_type}</span>
      <span class="corr-value">${esc(g.value)}</span>
      <div class="corr-meta">出现于 ${g.file_ids.length} 个文件</div>
    </div>`).join("");
  box.querySelectorAll(".corr-group").forEach((node) => {
    node.addEventListener("click", () => {
      const ids = JSON.parse(node.dataset.files);
      if (ids[0]) renderFile(ids[0]);
    });
  });
}

// ---------------------------------------------------------------------------
// 中栏: 文件查看 + 高亮 + 脱敏
// ---------------------------------------------------------------------------

function highlight(code, language) {
  let out = esc(code);
  if (language === "http") {
    out = out.replace(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE|CONNECT)\b/gm,
      '<span class="tok-method">$1</span>');
    out = out.replace(/^(HTTP\/\d\.\d \d{3}.*)$/gm,
      '<span class="tok-status">$1</span>');
    out = out.replace(/^([\w.-]+)(:)/gm, '<span class="tok-head">$1</span>$2');
  } else if (language === "json") {
    out = out.replace(/("(?:\\.|[^"\\])*")(\s*:)/g,
      '<span class="tok-key">$1</span>$2');
    out = out.replace(/:\s*("(?:\\.|[^"\\])*")/g,
      ': <span class="tok-str">$1</span>');
    out = out.replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
  } else if (language === "ini" || language === "yaml") {
    out = out.replace(/^(#{1,6}.*|;.*)$/gm, '<span class="tok-comment">$1</span>');
    out = out.replace(/^(\s*[\w.\-/$]+\s*)(:|=)/gm,
      '<span class="tok-key">$1</span>$2');
    out = out.replace(/^\[.*\]$/gm, '<span class="tok-head">$&</span>');
  } else if (language === "log" || language === "markdown") {
    out = out.replace(/\b(ERROR|CRITICAL|FATAL|WARN(?:ING)?)\b/g,
      '<span class="tok-status">$1</span>');
    out = out.replace(/\b(INFO|DEBUG|NOTICE|TRACE)\b/g,
      '<span class="tok-head">$1</span>');
    if (language === "markdown") {
      out = out.replace(/^(#{1,6}.*)$/gm, '<span class="tok-key">$1</span>');
    }
  }
  return out;
}

function markMaskedSpans(html, file) {
  // 后端给出命中行号; 在已转义的 HTML 中按行把占位符高亮
  const hitLines = new Set((file.masked_hits || []).map((h) => h.line_no));
  return html.split("\n").map((line, idx) => {
    if (hitLines.has(idx + 1) && line.includes("******")) {
      return line.replaceAll("******", '<span class="masked">******</span>');
    }
    return line;
  }).join("\n");
}

function withLineNumbers(html) {
  const lines = html.split("\n");
  return lines.map((l, i) =>
    `<span class="lineno">${String(i + 1).padStart(4, " ")}</span>${l}`
  ).join("\n");
}

async function renderFile(fileId) {
  state.selectedFileId = fileId;
  const query = state.maskOn ? "?mask=1" : "?mask=0";
  const f = await api(`/api/files/${encodeURIComponent(fileId)}${query}`);
  renderTree();

  $("#file-title").textContent = `${f.rel_path} [${KIND_LABEL[f.kind] || f.kind}]`;
  $("#file-meta").innerHTML = `
    <span>sha256: <code>${esc(f.sha256)}</code></span>
    <span>md5: <code>${esc(f.md5)}</code></span>
    <span>大小: ${f.size_bytes} B</span>
    <span>解析: ${esc(f.parserStatus || f.parse.parser)} / ${esc(f.parse.status)}</span>
    <span title="导入时的来源路径">来源: <code>${esc(f.source_path)}</code></span>
    <span>脱敏命中: ${f.masked_hit_count} 处</span>`;

  const dup = $("#duplicate-banner");
  if (f.duplicate_of) {
    dup.textContent = `⚠️ 重复证据: ${f.duplicate_reason}。两份证据均已保留, 未静默覆盖。`;
    dup.classList.remove("hidden");
  } else {
    dup.classList.add("hidden");
  }

  const warn = $("#parse-warn");
  if (f.parse.error || f.parse.truncated) {
    warn.textContent = `ℹ️ ${f.parse.error || "内容已截断"} —— 其他文件不受影响, 仍可查看原始字节元数据。`;
    warn.classList.remove("hidden");
  } else {
    warn.classList.add("hidden");
  }

  const view = $("#code-view");
  if (f.text === null) {
    view.textContent = "(二进制文件或读取失败, 仅保留校验值与元数据)";
    return;
  }
  let html = highlight(f.text, f.parse.language);
  if (state.maskOn) html = markMaskedSpans(html, f);
  view.innerHTML = withLineNumbers(html);
}

// ---------------------------------------------------------------------------
// 标注
// ---------------------------------------------------------------------------

function renderAnnotations() {
  const box = $("#ann-list");
  if (!state.data.annotations.length) {
    box.innerHTML = `<div class="muted" style="margin-top:8px">暂无复现记录。</div>`;
    return;
  }
  box.innerHTML = state.data.annotations.map((a) => `
    <div class="ann-card" data-ann="${a.id}">
      <div class="ann-title">${esc(a.title)}</div>
      <div class="ann-concl">结论: ${esc(a.conclusion || "(未填写)")}
        ${a.conclusion_history.length ? `· 历史 ${a.conclusion_history.length} 次` : ""}</div>
    </div>`).join("");
  box.querySelectorAll(".ann-card").forEach((n) =>
    n.addEventListener("click", () => openAnnotation(n.dataset.ann)));
}

async function openAnnotation(annId) {
  state.editingAnnotationId = annId;
  const a = annId
    ? state.data.annotations.find((x) => x.id === annId)
    : { title: "", steps: "", expected: "", actual: "", conclusion: "",
        linked_file_ids: [], conclusion_history: [] };
  $("#modal-title").textContent = annId ? "编辑复现记录" : "新增复现记录";
  $("#ann-title").value = a.title;
  $("#ann-steps").value = a.steps;
  $("#ann-expected").value = a.expected;
  $("#ann-actual").value = a.actual;
  $("#ann-conclusion").value = a.conclusion;

  const linked = new Set(a.linked_file_ids || []);
  $("#ann-linked").innerHTML = state.data.files.map((f) => `
    <label><input type="checkbox" value="${f.id}" ${linked.has(f.id) ? "checked" : ""}>
      ${esc(f.rel_path)}</label>`).join("") || '<span class="muted">请先导入证据文件</span>';

  $("#ann-history").innerHTML = (a.conclusion_history || []).length
    ? "<strong>结论变更历史 (不可删除)</strong>" + a.conclusion_history.map((h) =>
      `<div class="history-entry">${esc(h.changed_at)}<br>
       旧: ${esc(h.old_value || "(空)")}<br>新: ${esc(h.new_value || "(空)")}</div>`).join("")
    : "";
  $("#modal").classList.remove("hidden");
}

async function saveAnnotation() {
  const payload = {
    title: $("#ann-title").value,
    steps: $("#ann-steps").value,
    expected: $("#ann-expected").value,
    actual: $("#ann-actual").value,
    conclusion: $("#ann-conclusion").value,
    linked_file_ids: [...$("#ann-linked input:checked")].map((i) => i.value),
  };
  try {
    if (state.editingAnnotationId) {
      await api(`/api/annotations/${state.editingAnnotationId}`,
        { method: "PUT", body: payload });
    } else {
      await api("/api/annotations", { method: "POST", body: payload });
    }
    $("#modal").classList.add("hidden");
    toast("复现记录已保存", "ok");
    await refresh();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// 差异比较
// ---------------------------------------------------------------------------

function renderDiffSelectors() {
  const opts = state.data.packages.map((p) =>
    `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  $("#diff-a").innerHTML = opts;
  $("#diff-b").innerHTML = opts;
  if (state.data.packages[1]) {
    $("#diff-b").selectedIndex = 1;
  }
}

const STATUS_LABEL = {
  added: "仅 B 存在", removed: "B 缺失", modified: "已修改",
  order_only: "仅顺序变化", renamed: "仅路径变化", unchanged: "一致",
};

async function runDiff() {
  try {
    const result = await api("/api/diff", {
      method: "POST",
      body: {
        package_a_id: $("#diff-a").value,
        package_b_id: $("#diff-b").value,
      },
    });
    const c = result.counts;
    $("#diff-summary").innerHTML = `
      <div class="diff-counts">
        ${Object.entries(c).map(([k, v]) =>
          `<span class="pill ${k}">${STATUS_LABEL[k] || k}: ${v}</span>`).join("")}
      </div>
      <div class="muted">${esc(result.summary)}</div>`;
    $("#diff-result").innerHTML = result.diffs.map((d) => {
      const path = d.rel_path_b || d.rel_path_a;
      const lineDiff = d.detail && d.detail.line_diff
        ? `<div class="line-diff">${d.detail.line_diff.map((l) =>
          `<div class="${l.kind}">${esc(l.text)}</div>`).join("")}</div>` : "";
      const fieldDiff = d.detail && d.detail.field_diff
        ? `<div class="muted" style="margin-top:4px">字段差异: ${
            esc(JSON.stringify(d.detail.field_diff))}</div>` : "";
      const reason = d.detail && d.detail.reason
        ? `<div class="muted">${esc(d.detail.reason)}</div>` : "";
      return `<div class="diff-row ${d.status}">
        <span class="status">[${STATUS_LABEL[d.status] || d.status}]</span>
        ${esc(path)}${reason}${fieldDiff}${lineDiff}</div>`;
    }).join("");
  } catch (e) {
    toast(e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// 脱敏规则与导出
// ---------------------------------------------------------------------------

function renderMaskRules() {
  const s = state.data.mask_settings;
  $("#mask-rules").innerHTML = s.rules.map((r) => `
    <div class="rule-row">
      <div class="rule-name">
        <label class="switch"><input type="checkbox" data-rule="${r.id}"
          ${r.enabled ? "checked" : ""}> ${esc(r.name)}
          ${r.builtin ? '<span class="muted">(内置)</span>' : '<span class="muted">(自定义)</span>'}
        </label>
      </div>
      <code>${esc(r.pattern)}</code>
      ${r.description ? `<div class="muted">${esc(r.description)}</div>` : ""}
    </div>`).join("");
  $("#mask-rules input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      await api(`/api/mask/rules/${cb.dataset.rule}`, {
        method: "PUT", body: { enabled: cb.checked },
      });
      await refresh();
    });
  });
}

async function showPending() {
  const { pending } = await api("/api/mask/pending");
  if (!pending.length) {
    $("#mask-pending-box").innerHTML =
      '<div class="muted" style="margin-top:8px">未发现待脱敏项。</div>';
    return;
  }
  $("#mask-pending-box").innerHTML =
    `<strong style="display:block;margin-top:10px">导出前待脱敏项 (${
      pending.length} 类)</strong>` + pending.map((p) => `
      <div class="pending-row">
        <strong>${esc(p.rule_name)}</strong> · ${p.count} 处 ·
        涉及 ${p.files.length} 个文件<br>
        <span class="muted">样例将在导出时替换为 ****** ; 文件: ${
          esc(p.files.slice(0, 3).join(", "))}${p.files.length > 3 ? " ..." : ""}</span>
      </div>`).join("");
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function doExport(fmt) {
  try {
    await showPending();
    const r = await api(`/api/export?format=${fmt}`);
    if (r.format === "markdown") {
      download(r.filename, r.content, "text/markdown;charset=utf-8");
    } else {
      // 客户端再做一次占位符自检, 双保险
      const raw = JSON.stringify(r.content);
      if (raw.includes("******") === false && r.pending.length > 0) {
        throw new Error("客户端脱敏自检失败, 已中止导出");
      }
      download(r.filename, JSON.stringify(r.content, null, 2),
        "application/json;charset=utf-8");
    }
    toast(`已脱敏导出 ${r.filename}`, "ok");
    await refresh();
  } catch (e) {
    toast(e.message, "error");
  }
}

// ---------------------------------------------------------------------------
// 操作记录
// ---------------------------------------------------------------------------

function renderOps() {
  $("#ops-list").innerHTML = [...(state.data.operations || [])].reverse()
    .slice(0, 200).map((o) => `
      <div class="op-row"><span class="op-time">${esc(o.time)}</span>
        <strong>${esc(o.action)}</strong><br>${esc(o.detail)}</div>`).join("")
    || '<div class="muted">暂无操作记录</div>';
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

document.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  try {
    switch (act) {
      case "project-new": {
        const name = prompt("新工程名称", "未命名工程");
        if (name === null) return;
        await api("/api/project/new", { method: "POST", body: { name } });
        state.selectedFileId = null;
        await refresh();
        break;
      }
      case "project-open": {
        const p = prompt("输入要打开的工程文件绝对路径 (.json)");
        if (!p) return;
        await api("/api/project/open", { method: "POST", body: { path: p } });
        state.selectedFileId = null;
        await refresh();
        toast("工程已打开; 若文件损坏, 原工程会保持不变", "ok");
        break;
      }
      case "project-save":
      case "project-saveas": {
        let p = state.data.current_path;
        if (act === "project-saveas" || !p) {
          p = prompt("保存到哪个工程文件? (绝对路径, .json)", p || "");
        }
        if (!p) return;
        const r = await api("/api/project/save",
          { method: "POST", body: { path: p, name: $("#project-name").value } });
        await refresh();
        toast(`已保存: ${r.path}`, "ok");
        break;
      }
      case "import-package": {
        const p = prompt("输入复现包的本机绝对路径 (目录或 zip)");
        if (!p) return;
        const r = await api("/api/import", { method: "POST", body: { path: p } });
        await refresh();
        toast(`导入完成: ${r.file_count} 个文件, ${r.duplicates.length} 个重复证据`,
          "ok");
        break;
      }
      case "rebuild-corr":
        await api("/api/correlations/rebuild", { method: "POST" });
        await refresh();
        break;
      case "reveal": {
        if (!state.selectedFileId) return toast("请先选择文件");
        const reason = prompt("查看脱敏原文需要登记原因 (将写入审计日志)");
        if (reason === null) return;
        const r = await api(
          `/api/files/${state.selectedFileId}/reveal`,
          { method: "POST", body: { reason } });
        $("#code-view").textContent = r.text;
        toast("原文仅本次展示, 导出仍会脱敏; 该操作已记录", "ok");
        break;
      }
      case "ann-new":
        await openAnnotation(null);
        break;
      case "ann-save":
        await saveAnnotation();
        break;
      case "modal-close":
        $("#modal").classList.add("hidden");
        break;
      case "diff-run":
        await runDiff();
        break;
      case "mask-add": {
        const name = prompt("规则名称");
        if (!name) return;
        const pattern = prompt("正则表达式 (Python re 语法)");
        if (!pattern) return;
        await api("/api/mask/rules", {
          method: "POST",
          body: { name, pattern, description: "界面添加的自定义规则" },
        });
        await refresh();
        toast("自定义脱敏规则已生效", "ok");
        break;
      }
      case "mask-pending":
        await showPending();
        break;
      case "export-json":
        await doExport("json");
        break;
      case "export-md":
        await doExport("markdown");
        break;
    }
  } catch (e) {
    toast(e.message, "error");
  }
});

$("#mask-toggle").addEventListener("change", async (e) => {
  state.maskOn = e.target.checked;
  if (state.selectedFileId) await renderFile(state.selectedFileId);
});
$("#hide-default").addEventListener("change", async (e) => {
  await api("/api/mask/mode", {
    method: "POST", body: { hide_by_default: e.target.checked },
  });
  state.maskOn = e.target.checked;
  $("#mask-toggle").checked = e.target.checked;
  if (state.selectedFileId) await renderFile(state.selectedFileId);
});
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) =>
      p.classList.remove("active"));
    tab.classList.add("active");
    $(`#tab-${tab.dataset.tab}`).classList.add("active");
  });
});
$("#project-name").addEventListener("change", async (e) => {
  state.data.name = e.target.value;
  await api("/api/project/save", {
    method: "POST",
    body: { path: state.data.current_path || "", name: e.target.value },
  }).catch(() => null); // 未设置路径时静默, 等待显式保存
});

refresh().catch((e) => toast(`初始化失败: ${e.message}`, "error"));
