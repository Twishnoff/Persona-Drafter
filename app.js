// Persona Drafter — frontend app logic: form handling, Turnstile, streaming
// the research run from the Worker, and rendering the six result boxes.
// Field names here must match worker/src/lib/schema.js (finalize_persona).

(function () {
  const cfg = window.PERSONA_DRAFTER_CONFIG || {};

  const form = document.getElementById("persona-form");
  const emailInput = document.getElementById("email");
  const jobTitleInput = document.getElementById("jobTitle");
  const companySizeInput = document.getElementById("companySize");
  const industryInput = document.getElementById("industry");
  const generateBtn = document.getElementById("generate-btn");
  const formError = document.getElementById("form-error");
  const pdfBtn = document.getElementById("pdf-btn");
  const runStatus = document.getElementById("run-status");

  let turnstileToken = null;
  let turnstileWidgetId = null;
  let lastPersona = null;

  // --- Turnstile -------------------------------------------------------------

  window.onTurnstileLoad = function () {
    if (!window.turnstile || !cfg.TURNSTILE_SITE_KEY) return;
    turnstileWidgetId = turnstile.render("#turnstile-widget", {
      sitekey: cfg.TURNSTILE_SITE_KEY,
      callback: (token) => {
        turnstileToken = token;
        updateGenerateEnabled();
      },
      "expired-callback": () => {
        turnstileToken = null;
        updateGenerateEnabled();
      },
    });
  };

  // --- Form enabling -----------------------------------------------------------

  function updateGenerateEnabled() {
    const ready =
      emailInput.value.trim() &&
      jobTitleInput.value.trim() &&
      companySizeInput.value &&
      !!turnstileToken;
    generateBtn.disabled = !ready;
  }

  [emailInput, jobTitleInput, companySizeInput].forEach((el) =>
    el.addEventListener("input", updateGenerateEnabled)
  );
  companySizeInput.addEventListener("change", updateGenerateEnabled);

  // --- Box state helpers -------------------------------------------------------

  const boxes = {
    overview: document.querySelector("#box-overview .box-body"),
    profiles: document.querySelector("#box-profiles .box-body"),
    gather: document.querySelector("#box-gather .box-body"),
    org: document.querySelector("#box-org .box-body"),
    work: document.querySelector("#box-work .box-body"),
    development: document.querySelector("#box-development .box-body"),
  };

  function setAllBoxesLoading() {
    Object.values(boxes).forEach((el) => {
      el.className = "box-body loading";
      el.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    });
  }

  function setAllBoxesPlaceholder() {
    Object.values(boxes).forEach((el) => {
      el.className = "box-body placeholder";
      el.textContent = "No Data Collected";
    });
  }

  function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  function linkOrText(text, url) {
    const safeText = escapeHtml(text);
    if (!url) return safeText;
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${safeText}</a>`;
  }

  // --- Renderers, one per box --------------------------------------------------

  function renderOverview(o) {
    const el = boxes.overview;
    el.className = "box-body";
    if (!o) { el.innerHTML = '<p class="empty-note">No overview data returned.</p>'; return; }

    const tools = (o.common_tools || [])
      .map((t) => linkOrText(t.name, t.url))
      .join(", ") || '<span class="empty-note">none found</span>';

    const rows = [
      ["Primary Job Title", escapeHtml(o.primary_job_title)],
      ["Secondary Job Titles", escapeHtml((o.secondary_job_titles || []).join(", ")) || '<span class="empty-note">none found</span>'],
      ["Job Level", escapeHtml(o.job_level)],
      ["Average Years of Experience", escapeHtml(o.avg_years_experience)],
      ["Company Size", escapeHtml(o.company_size_label)],
      ["Industry", escapeHtml(o.industry_label) || '<span class="empty-note">not specified</span>'],
      ["Common Tools", tools],
    ];

    el.innerHTML =
      '<div class="kv-list">' +
      rows.map(([k, v]) => `<div class="row"><span class="k">${k}:</span><span class="v">${v}</span></div>`).join("") +
      "</div>";
  }

  function renderProfiles(rows) {
    const el = boxes.profiles;
    el.className = "box-body";
    if (!rows || rows.length === 0) {
      el.innerHTML = '<p class="empty-note">No matching public profiles found.</p>';
      return;
    }
    el.innerHTML =
      "<table><thead><tr><th>Job Title</th><th>Company</th><th>Link</th></tr></thead><tbody>" +
      rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.job_title)}</td><td>${escapeHtml(r.company)}</td><td>${linkOrText("Profile", r.url)}</td></tr>`
        )
        .join("") +
      "</tbody></table>";
  }

  function renderGather(rows) {
    const el = boxes.gather;
    el.className = "box-body";
    if (!rows || rows.length === 0) {
      el.innerHTML = '<p class="empty-note">No channels found.</p>';
      return;
    }
    el.innerHTML =
      "<table><thead><tr><th>Name</th><th>Type</th><th>Link</th></tr></thead><tbody>" +
      rows
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.type)}</td><td>${linkOrText("Visit", r.url)}</td></tr>`
        )
        .join("") +
      "</tbody></table>";
  }

  function renderOrg(org) {
    const el = boxes.org;
    el.className = "box-body";
    if (!org) { el.innerHTML = '<p class="empty-note">No org structure data returned.</p>'; return; }

    const parts = [];
    if (org.reports_to) {
      parts.push(`<div class="tier"><span class="label">Reports To</span>${escapeHtml(org.reports_to)}</div>`);
      parts.push('<div class="connector"></div>');
    }
    parts.push(`<div class="tier this-role"><span class="label">This Role</span>${escapeHtml(org.this_role)}</div>`);

    const hasManages = !!org.manages;
    const hasStakeholders = (org.stakeholders || []).length > 0;
    if (hasManages || hasStakeholders) {
      parts.push('<div class="connector"></div>');
      const branchParts = [];
      if (hasManages) {
        branchParts.push(`<div class="tier"><span class="label">Manages</span>${escapeHtml(org.manages)}</div>`);
      }
      if (hasStakeholders) {
        const stakeholderHtml = org.stakeholders
          .map((s) => linkOrText(s.name, s.url))
          .join(", ");
        branchParts.push(`<div class="tier"><span class="label">Stakeholders</span>${stakeholderHtml}</div>`);
      }
      parts.push(`<div class="branches">${branchParts.join("")}</div>`);
    }

    el.innerHTML = `<div class="orgchart">${parts.join("")}</div>`;
  }

  function renderRankList(target, items, emptyMsg) {
    const el = boxes[target];
    el.className = "box-body";
    if (!items || items.length === 0) {
      el.innerHTML = `<p class="empty-note">${emptyMsg}</p>`;
      return;
    }
    el.innerHTML = "<ol class=\"rank-list\">" + items.map((i) => `<li>${escapeHtml(i)}</li>`).join("") + "</ol>";
  }

  function renderPersona(persona) {
    renderOverview(persona.overview);
    renderProfiles(persona.sample_profiles);
    renderGather(persona.where_they_gather);
    renderOrg(persona.org_structure);
    renderRankList("work", persona.work_priorities, "No priorities found.");
    renderRankList("development", persona.development_priorities, "No priorities found.");
  }

  // --- Form errors ---------------------------------------------------------

  function showFormError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
  }
  function clearFormError() {
    formError.hidden = true;
    formError.textContent = "";
  }

  // --- SSE parsing over a fetch() stream (EventSource can't send a POST body) --

  async function streamGenerate(payload, { onStatus, onResult, onError }) {
    const resp = await fetch(`${cfg.API_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      let message = `Request failed (${resp.status}).`;
      try {
        const data = await resp.json();
        if (data && data.error) message = data.error;
      } catch { /* ignore parse failure, use default message */ }
      onError(message);
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sepIndex;
      while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + 2);
        const eventMatch = rawEvent.match(/^event:\s*(.+)$/m);
        const dataMatch = rawEvent.match(/^data:\s*(.+)$/m);
        if (!dataMatch) continue;

        const eventType = eventMatch ? eventMatch[1].trim() : "message";
        let data;
        try {
          data = JSON.parse(dataMatch[1]);
        } catch {
          continue;
        }

        if (eventType === "status") onStatus(data.message);
        else if (eventType === "result") onResult(data);
        else if (eventType === "error") onError(data.message);
      }
    }
  }

  // --- Submit handler --------------------------------------------------------

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFormError();

    if (!cfg.API_BASE_URL || cfg.API_BASE_URL.includes("YOUR-SUBDOMAIN")) {
      showFormError("This page isn't configured yet — set API_BASE_URL in config.js.");
      return;
    }

    generateBtn.disabled = true;
    pdfBtn.disabled = true;
    lastPersona = null;
    setAllBoxesLoading();
    runStatus.textContent = "Conducting Research…";

    const payload = {
      email: emailInput.value.trim(),
      jobTitle: jobTitleInput.value.trim(),
      companySize: companySizeInput.value,
      industry: industryInput.value.trim(),
      turnstileToken,
    };

    try {
      await streamGenerate(payload, {
        onStatus: (message) => {
          runStatus.textContent = message || "Conducting Research…";
        },
        onResult: (data) => {
          lastPersona = data.persona;
          renderPersona(data.persona);
          runStatus.textContent = data.partial
            ? "Done — research budget ran out before every box was fully filled in."
            : "Research complete.";
          pdfBtn.disabled = false;
        },
        onError: (message) => {
          setAllBoxesPlaceholder();
          showFormError(message || "Something went wrong. Please try again.");
          runStatus.textContent = "";
        },
      });
    } catch (err) {
      console.error(err);
      setAllBoxesPlaceholder();
      showFormError("Network error — please try again.");
      runStatus.textContent = "";
    } finally {
      // Turnstile tokens are single-use; reset the widget for the next run.
      if (window.turnstile && turnstileWidgetId !== null) {
        turnstile.reset(turnstileWidgetId);
      }
      turnstileToken = null;
      updateGenerateEnabled();
    }
  });

  window.__personaDrafter = { getLastPersona: () => lastPersona };
})();
