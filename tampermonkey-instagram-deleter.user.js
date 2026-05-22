// ==UserScript==
// @name         Instagram Direct Deleter
// @namespace    instagram-deleter
// @version      1.3.0
// @description  Clean Tampermonkey interface to scan, export, and delete your Instagram Direct messages
// @match        https://www.instagram.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(async () => {
  "use strict";

  const PANEL_ID = "ig-direct-deleter-panel";
  const BUTTON_ID = "ig-direct-deleter-open";
  const CAPTURE_EVENT_NAME = "IG_DIRECT_DELETER_CAPTURE";
  const GRAPHQL_URL = "https://www.instagram.com/api/graphql/";
  const GRAPHQL_PATH = "/api/graphql/";
  const STORAGE_KEY = "ig-direct-deleter-settings";
  const UI_STORAGE_KEY = "ig-direct-deleter-ui";
  const THREAD_URL_REGEX = /\/direct\/t\/(\d+)(?:\/|$)/;
  const ASSET_FETCH_TIMEOUT_MS = 8000;
  const MAX_EXPORT_ASSETS = 150;
  const EXPORT_ASSET_CONCURRENCY = 6;
  const MAX_EXPORT_ASSET_BYTES = 20 * 1024 * 1024;
  const MAX_EXPORT_TOTAL_ASSET_BYTES = 80 * 1024 * 1024;

  const DEFAULT_SETTINGS = {
    csrftoken: "",
    fbDtsg: "",
    lsd: "RXf73QMvFlJi1rOGssZkkV",
    cookie: "",
    userId: "",
    fetchDocId: "26761814000110708",
    deleteDocId: "24812777031749983",
    batchSize: 20,
    pageDelayMs: 700,
    deleteDelayMs: 1200,
    onlyOwn: true,
    messageId: "",
    contentType: "",
    olderThan: "",
    newerThan: "",
    hasText: false,
    hasMedia: false,
  };

  const DEFAULT_UI = {
    detached: false,
    x: 24,
    y: 24,
    width: 680,
  };

  const state = {
    open: location.pathname.startsWith("/direct"),
    activeTab: "run",
    settings: { ...DEFAULT_SETTINGS },
    ui: { ...DEFAULT_UI },
    latestCapture: null,
    fetchTemplateCapture: null,
    deleteTemplateCapture: null,
    threadId: "",
    threadUrl: "",
    messages: [],
    targetedMessages: [],
    scanComplete: false,
    running: false,
    abortRequested: false,
    status: "Ready.",
    logs: [],
    stats: {
      loaded: 0,
      targeted: 0,
      deleted: 0,
      failed: 0,
    },
  };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

  function normalizeSettings(savedSettings = {}) {
    const settings = { ...DEFAULT_SETTINGS };

    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (Object.prototype.hasOwnProperty.call(savedSettings, key)) {
        settings[key] = savedSettings[key];
      }
    }

    return settings;
  }

  function clampNumber(value, min, max) {
    const parsed = Number.parseInt(String(value), 10);
    const safeValue = Number.isFinite(parsed) ? parsed : min;
    return Math.min(Math.max(safeValue, min), max);
  }

  function clampPanelPosition(x, y) {
    const panelWidth = Math.min(state.ui.width || DEFAULT_UI.width, window.innerWidth - 24);
    const maxX = Math.max(12, window.innerWidth - panelWidth - 12);
    const maxY = Math.max(12, window.innerHeight - 96);

    return {
      x: clampNumber(x, 12, maxX),
      y: clampNumber(y, 12, maxY),
    };
  }

  function getPanelPositionStyle() {
    const width = clampNumber(state.ui.width, 320, Math.max(320, window.innerWidth - 24));

    if (!state.ui.detached) {
      return [
        "left:50%",
        "top:50%",
        "right:auto",
        "width:min(720px, calc(100vw - 32px))",
        "transform:translate(-50%, -50%)",
      ].join(";");
    }

    const position = clampPanelPosition(state.ui.x, state.ui.y);
    state.ui.x = position.x;
    state.ui.y = position.y;

    return [
      `left:${position.x}px`,
      `top:${position.y}px`,
      "right:auto",
      `width:min(${width}px, calc(100vw - 24px))`,
      "transform:none",
    ].join(";");
  }

  function applyPanelPosition() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    panel.classList.toggle("detached", Boolean(state.ui.detached));
    panel.classList.toggle("modal", !state.ui.detached);
    panel.style.cssText = getPanelPositionStyle();
  }

  async function saveUiState() {
    await gmSetValue(UI_STORAGE_KEY, state.ui);
  }

  async function gmGetValue(key, fallback) {
    if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
    if (typeof GM !== "undefined" && GM.getValue) return await GM.getValue(key, fallback);
    return fallback;
  }

  async function gmSetValue(key, value) {
    if (typeof GM_setValue === "function") return GM_setValue(key, value);
    if (typeof GM !== "undefined" && GM.setValue) return await GM.setValue(key, value);
  }

  async function gmDeleteValue(key) {
    if (typeof GM_deleteValue === "function") return GM_deleteValue(key);
    if (typeof GM !== "undefined" && GM.deleteValue) return await GM.deleteValue(key);
  }

  async function gmSetClipboard(value) {
    if (typeof GM_setClipboard === "function") return GM_setClipboard(value, "text");
    await navigator.clipboard.writeText(value);
  }

  function log(message, level = "info") {
    const entry = {
      time: new Date().toLocaleTimeString(),
      level,
      message: String(message),
    };

    state.logs.push(entry);
    if (state.logs.length > 300) state.logs.shift();

    const logEl = document.querySelector(`#${PANEL_ID} [data-role="logs"]`);
    if (logEl) {
      logEl.textContent = formatLogs();
      logEl.scrollTop = logEl.scrollHeight;
    }

    console[level === "error" ? "error" : "log"]("[IG Direct Deleter]", message);
  }

  function setStatus(message) {
    state.status = message;
    const el = document.querySelector(`#${PANEL_ID} [data-role="status"]`);
    if (el) el.textContent = message;
  }

  function formatLogs() {
    return state.logs.map((entry) => `[${entry.time}] ${entry.message}`).join("\n");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function parseCookieHeader(cookieHeader) {
    const cookies = new Map();

    String(cookieHeader || "")
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .forEach((part) => {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex === -1) return;
        cookies.set(part.slice(0, separatorIndex), part.slice(separatorIndex + 1));
      });

    return cookies;
  }

  function getCookieValue(name) {
    return parseCookieHeader(document.cookie).get(name) || "";
  }

  function extractFormValue(body, key) {
    if (!body) return "";

    try {
      const params = new URLSearchParams(typeof body === "string" ? body : String(body));
      return params.get(key) || "";
    } catch {
      return "";
    }
  }

  function lowerCaseHeaders(headers) {
    const output = {};

    for (const [key, value] of Object.entries(headers || {})) {
      output[String(key).toLowerCase()] = value;
    }

    return output;
  }

  function parseEnvBlock(raw) {
    const values = {};

    for (const line of String(raw || "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;

      const key = match[1];
      let value = match[2] || "";

      try {
        if (
          (value.startsWith("\"") && value.endsWith("\"")) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = JSON.parse(value.replace(/^'/, "\"").replace(/'$/, "\""));
        }
      } catch {
        value = value.replace(/^["']|["']$/g, "");
      }

      values[key] = value;
    }

    return values;
  }

  function extractThreadId(value) {
    const cleaned = String(value || "").trim().replace(/^["']|["']$/g, "");
    if (/^\d+$/.test(cleaned)) return cleaned;

    const match = cleaned.match(THREAD_URL_REGEX);
    return match?.[1] || "";
  }

  function buildThreadUrl(threadId) {
    return threadId ? `https://www.instagram.com/direct/t/${threadId}/` : "";
  }

  function detectThreadFromPage() {
    const fromPath = extractThreadId(location.pathname);
    if (fromPath) return { threadId: fromPath, threadUrl: buildThreadUrl(fromPath) };

    const link = Array.from(document.querySelectorAll("a[href]"))
      .map((node) => node.getAttribute("href"))
      .find((href) => extractThreadId(href));
    const threadId = extractThreadId(link);

    return {
      threadId,
      threadUrl: buildThreadUrl(threadId),
    };
  }

  function getCapturedGraphQLParams(capture = state.latestCapture) {
    const body = capture?.body || "";

    try {
      return new URLSearchParams(body);
    } catch {
      return new URLSearchParams();
    }
  }

  function getCaptureFriendlyName(capture) {
    return extractFormValue(capture?.body, "fb_api_req_friendly_name");
  }

  function getCaptureDocId(capture) {
    return extractFormValue(capture?.body, "doc_id");
  }

  function getCaptureVariables(capture) {
    const raw = extractFormValue(capture?.body, "variables");
    if (!raw) return {};

    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  function rememberGraphQLTemplate(capture) {
    const friendlyName = getCaptureFriendlyName(capture);
    const friendlyNameLower = friendlyName.toLowerCase();
    const docId = getCaptureDocId(capture);
    const variables = getCaptureVariables(capture);
    const variableThreadId = extractThreadId(variables.id || "");
    const matchesCurrentThread = !state.threadId || !variableThreadId || variableThreadId === state.threadId;
    const hasPaginationShape =
      Object.prototype.hasOwnProperty.call(variables, "first") ||
      Object.prototype.hasOwnProperty.call(variables, "after") ||
      Object.prototype.hasOwnProperty.call(variables, "before") ||
      Object.prototype.hasOwnProperty.call(variables, "last");
    const looksLikeMessageList =
      friendlyNameLower.includes("messagelist") ||
      friendlyNameLower.includes("slidethread") ||
      (
        friendlyNameLower.includes("direct") &&
        Boolean(variables.id) &&
        Object.prototype.hasOwnProperty.call(variables, "older_than_message_id")
      ) ||
      (
        Boolean(variables.id) &&
        hasPaginationShape &&
        matchesCurrentThread
      );

    if (looksLikeMessageList) {
      state.fetchTemplateCapture = capture;
      if (docId) state.settings.fetchDocId = docId;
      return "message-list";
    }

    if (friendlyName.includes("Unsend")) {
      state.deleteTemplateCapture = capture;
      if (docId) state.settings.deleteDocId = docId;
      return "unsend";
    }

    return "";
  }

  function getEffectiveSettings() {
    const pageCookies = parseCookieHeader(document.cookie);
    const inputCookies = parseCookieHeader(state.settings.cookie);
    const capturedHeaders = lowerCaseHeaders(state.latestCapture?.headers || {});

    return {
      ...state.settings,
      csrftoken:
        state.settings.csrftoken ||
        capturedHeaders["x-csrftoken"] ||
        inputCookies.get("csrftoken") ||
        pageCookies.get("csrftoken") ||
        "",
      fbDtsg:
        state.settings.fbDtsg ||
        extractFormValue(state.latestCapture?.body, "fb_dtsg") ||
        "",
      lsd:
        state.settings.lsd ||
        capturedHeaders["x-fb-lsd"] ||
        extractFormValue(state.latestCapture?.body, "lsd") ||
        DEFAULT_SETTINGS.lsd,
      userId:
        state.settings.userId ||
        inputCookies.get("ds_user_id") ||
        pageCookies.get("ds_user_id") ||
        "",
      fetchDocId: state.settings.fetchDocId || DEFAULT_SETTINGS.fetchDocId,
      deleteDocId: state.settings.deleteDocId || DEFAULT_SETTINGS.deleteDocId,
      batchSize: numberOrDefault(state.settings.batchSize, DEFAULT_SETTINGS.batchSize),
      pageDelayMs: numberOrDefault(state.settings.pageDelayMs, DEFAULT_SETTINGS.pageDelayMs),
      deleteDelayMs: numberOrDefault(state.settings.deleteDelayMs, DEFAULT_SETTINGS.deleteDelayMs),
    };
  }

  function numberOrDefault(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function applyCapturedCredentials(overwrite = false) {
    const effective = getEffectiveSettings();
    const friendlyName = getCaptureFriendlyName(state.latestCapture);
    const docId = getCaptureDocId(state.latestCapture);

    for (const key of ["csrftoken", "fbDtsg", "lsd", "userId"]) {
      if (overwrite || !state.settings[key]) {
        state.settings[key] = effective[key] || state.settings[key];
      }
    }

    if (docId && friendlyName.includes("IGDMessageList")) {
      state.settings.fetchDocId = docId;
    }

    if (docId && friendlyName.includes("Unsend")) {
      state.settings.deleteDocId = docId;
    }
  }

  function collectFormValues() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
      const field = panel.querySelector(`[name="${key}"]`);
      if (!field) continue;

      if (field.type === "checkbox") {
        state.settings[key] = field.checked;
      } else if (typeof fallback === "number") {
        state.settings[key] = numberOrDefault(field.value, fallback);
      } else {
        state.settings[key] = field.value.trim();
      }
    }

    const threadField = panel.querySelector('[name="threadInput"]');
    if (threadField) {
      const threadId = extractThreadId(threadField.value);
      if (threadId) {
        state.threadId = threadId;
        state.threadUrl = buildThreadUrl(threadId);
      }
    }
  }

  async function saveSettings() {
    collectFormValues();
    await gmSetValue(STORAGE_KEY, state.settings);
    log("Settings saved.");
    render();
  }

  async function clearSettings() {
    await gmDeleteValue(STORAGE_KEY);
    state.settings = { ...DEFAULT_SETTINGS };
    log("Settings cleared.");
    render();
  }

  function buildGraphQLBody(friendlyName, docId, variables, templateCapture = null) {
    const effective = getEffectiveSettings();
    const params = getCapturedGraphQLParams(templateCapture);
    const defaultReq = friendlyName.includes("Unsend") ? "29" : "22";

    const defaults = {
      av: "17841441681363841",
      __d: "www",
      __user: "0",
      __a: "1",
      __req: defaultReq,
      __hs: "20536.HYP:instagram_web_pkg.2.1...0",
      dpr: "1",
      __ccg: "EXCELLENT",
      __rev: "1035833417",
      __s: "placeholder:placeholder:placeholder",
      __hsi: "7620880875497683364",
      __dyn: "7xeUjG1mxu1syaxG4Vp41twpUnwgU7SbzEdF8aUco2qwJyEiw9-1DwUx609vCwjE1EEc87m0yE462mcw5Mx62G5UswoEcE7O2l0Fwqo31w9a9wlo8od8-U2exi4UaEW2G0AEco5G0zK5o4q3y261kx-0ma2-azo7u3vwDwHg2ZwrUK2K2WE5B08-269wr86C1mgcEed6hEhK2OubK5V89FbxG1oxe6U5q0EoKmUhw4UAxCaCwHwi84q2i1cwbG",
      __csr: "placeholder",
      __hsdp: "placeholder",
      __hblp: "placeholder",
      __sjsp: "placeholder",
      __comet_req: "7",
      jazoest: "26196",
      __spin_r: "1035833417",
      __spin_b: "trunk",
      __crn: "comet.igweb.PolarisDirectInboxRoute",
      fb_api_caller_class: "RelayModern",
      server_timestamps: "true",
    };

    for (const [key, value] of Object.entries(defaults)) {
      if (!params.has(key)) params.set(key, value);
    }

    params.set("__spin_t", Math.floor(Date.now() / 1000).toString());
    params.set("fb_dtsg", effective.fbDtsg || "placeholder");
    params.set("lsd", effective.lsd || "placeholder");
    params.set("fb_api_req_friendly_name", friendlyName);
    params.set("variables", JSON.stringify(variables));
    params.set("doc_id", docId);

    return params.toString();
  }

  function buildHeaders(friendlyName, rootFieldName, templateCapture = null) {
    const effective = getEffectiveSettings();
    const capturedHeaders = lowerCaseHeaders(templateCapture?.headers || state.latestCapture?.headers || {});

    return {
      accept: "*/*",
      "accept-language": navigator.language || "en-US,en;q=0.9",
      "content-type": "application/x-www-form-urlencoded",
      "x-fb-friendly-name": friendlyName,
      "x-root-field-name": rootFieldName,
      "x-asbd-id": capturedHeaders["x-asbd-id"] || "359341",
      "x-csrftoken": effective.csrftoken,
      "x-fb-lsd": effective.lsd,
      "x-ig-app-id": capturedHeaders["x-ig-app-id"] || "936619743392459",
    };
  }

  async function postGraphQL(friendlyName, docId, variables, options = {}) {
    const rootFieldName = options.rootFieldName || "";
    const templateCapture = options.templateCapture || null;

    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: buildHeaders(friendlyName, rootFieldName, templateCapture),
      body: buildGraphQLBody(friendlyName, docId, variables, templateCapture),
      credentials: "include",
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Instagram returned a non-JSON response. The session may have expired: ${text.slice(0, 300)}`);
    }

    if (json.errors?.length) {
      throw new Error(formatGraphQLError(json.errors[0]));
    }

    return json;
  }

  async function fetchMessagesPage(threadId, after) {
    const effective = getEffectiveSettings();
    const template = state.fetchTemplateCapture;
    const templateVariables = getCaptureVariables(template);
    const variables = {
      ...templateVariables,
      after: after || null,
      before: null,
      first: effective.batchSize,
      last: null,
      newer_than_message_id: null,
      older_than_message_id: null,
      id: threadId,
      "__relay_internal__pv__IGDInitialMessagePageCountrelayprovider": 20,
      "__relay_internal__pv__IGDEnableOffMsysPinnedMessagesQErelayprovider": false,
    };

    const friendlyName = getCaptureFriendlyName(template) || "IGDMessageListOffMsysQuery";
    const docId = getCaptureDocId(template) || effective.fetchDocId;
    const json = await postGraphQL(friendlyName, docId, variables, {
      rootFieldName: "fetch__SlideThread",
      templateCapture: template,
    });
    const slideMessages = json.data?.fetch__SlideThread?.as_ig_direct_thread?.slide_messages;

    if (!slideMessages) {
      throw new Error("Instagram did not return messages for this conversation.");
    }

    return slideMessages;
  }

  async function deleteMessage(message) {
    const effective = getEffectiveSettings();
    const template = state.deleteTemplateCapture;
    const templateVariables = getCaptureVariables(template);
    const variables = {
      ...templateVariables,
      message_id: message.message_id,
      send_data: {
        thread_id: message.thread_fbid || state.threadId,
      },
    };

    const friendlyName = getCaptureFriendlyName(template) || "IGDMessageUnsendDialogOffMsysMutation";
    const docId = getCaptureDocId(template) || effective.deleteDocId;

    return await postGraphQL(friendlyName, docId, variables, {
      rootFieldName: "igd_message_unsend_dialog_off_msys",
      templateCapture: template,
    });
  }

  function formatGraphQLError(error) {
    return [
      error?.message,
      error?.summary,
      error?.code ? `code=${error.code}` : "",
      error?.api_error_code ? `api_error_code=${error.api_error_code}` : "",
      error?.path?.length ? `path=${error.path.join(".")}` : "",
    ].filter(Boolean).join(" | ");
  }

  function getSenderUsername(message) {
    return (
      message?.sender?.user_dict?.username ||
      message?.sender?.username ||
      message?.sender?.name ||
      message?.sender?.id ||
      "unknown"
    );
  }

  function getSenderAccountId(message) {
    return message?.sender?.user_dict?.id || message?.sender?.igid || message?.sender?.id || "";
  }

  function getMessageText(message) {
    return message?.text_body || message?.content?.text_body || message?.content?.xma_text_body || "";
  }

  function shortText(value, max = 90) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 3)}...` : text;
  }

  function timestampToLocal(timestampMs) {
    const parsed = Number.parseInt(String(timestampMs || "0"), 10);
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : "";
  }

  function timestampNumber(message) {
    const parsed = Number.parseInt(String(message?.timestamp_ms || "0"), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeTextForExport(value) {
    return String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim();
  }

  function collectUrls(value, urls = new Set(), depth = 0) {
    if (!value || depth > 6 || urls.size >= 10) return urls;

    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value)) urls.add(value);
      return urls;
    }

    if (Array.isArray(value)) {
      for (const item of value) collectUrls(item, urls, depth + 1);
      return urls;
    }

    if (typeof value === "object") {
      for (const item of Object.values(value)) collectUrls(item, urls, depth + 1);
    }

    return urls;
  }

  function collectUrlEntries(value, entries = [], path = "", seen = new Set(), depth = 0) {
    if (!value || depth > 8 || entries.length >= 120) return entries;

    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && !seen.has(value)) {
        seen.add(value);
        entries.push({
          url: value,
          path,
          isAsset: isDownloadableAssetUrl(value, path),
        });
      }

      return entries;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => collectUrlEntries(item, entries, `${path}[${index}]`, seen, depth + 1));
      return entries;
    }

    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        collectUrlEntries(item, entries, path ? `${path}.${key}` : key, seen, depth + 1);
      }
    }

    return entries;
  }

  function isDownloadableAssetUrl(url, path = "") {
    const lowerUrl = String(url || "").toLowerCase();
    const lowerPath = String(path || "").toLowerCase();

    if (/profile_pic|header_icon|favicon|avatar/.test(lowerPath)) return false;
    if (/target_url|permalink|canonical/.test(lowerPath)) return false;
    if (/instagram\.com\/(reel|p|stories|explore|direct)\//.test(lowerUrl)) return false;

    return (
      /preview_image|fallback_url|image|media|video|audio|attachment|file|thumbnail/.test(lowerPath) ||
      /cdninstagram|fbcdn|scontent|direct_v2\/media_fallback/.test(lowerUrl) ||
      /\.(apng|avif|gif|jpe?g|png|svg|webp|bmp|mp4|mov|m4v|webm|mp3|m4a|ogg|wav|pdf)(?:[?#]|$)/i.test(lowerUrl)
    );
  }

  function getMessageUrlEntries(message) {
    return collectUrlEntries(message || {}).filter((entry) => {
      const lowerPath = String(entry.path || "").toLowerCase();
      const lowerUrl = String(entry.url || "").toLowerCase();
      return !/profile_pic|header_icon|favicon|avatar/.test(lowerPath) && !lowerUrl.includes("profile_pic");
    });
  }

  function getMessageAssetEntries(message) {
    return getMessageUrlEntries(message).filter((entry) => entry.isAsset);
  }

  function getMessageLinkEntries(message) {
    return getMessageUrlEntries(message).filter((entry) => !entry.isAsset);
  }

  function getMessageExportContent(message) {
    const lines = [];
    const text = normalizeTextForExport(getMessageText(message));
    const xma = message?.content?.xma || {};
    const title = xma.xmaHeaderTitle || xma.header_title_text || xma.caption_body_text || "";
    const subtitle = xma.header_subtitle_text || xma.eyebrow_text || "";
    const urls = Array.from(collectUrls(message?.content)).filter((url) => !url.includes("profile_pic"));

    if (text) lines.push(text);
    if (title && title !== text) lines.push(`Title: ${title}`);
    if (subtitle && subtitle !== text && subtitle !== title) lines.push(`Detail: ${subtitle}`);
    if (urls.length) lines.push(`Links: ${urls.slice(0, 5).join(" | ")}`);

    return lines.join("\n") || "[non-text content]";
  }

  function formatMessageForExport(message) {
    const senderId = getSenderAccountId(message);
    const sender = [getSenderUsername(message), senderId ? `(${senderId})` : ""].filter(Boolean).join(" ");

    return [
      `[${timestampToLocal(message.timestamp_ms) || "unknown date"}] ${sender}`,
      `Message ID: ${message.message_id || "unknown"}`,
      `Type: ${message.content_type || "unknown"}`,
      `Content: ${getMessageExportContent(message)}`,
    ].join("\n");
  }

  function buildConversationTxt() {
    const messages = [...state.messages].sort((a, b) => timestampNumber(a) - timestampNumber(b));
    const header = [
      "Instagram Direct Deleter - Conversation export",
      `Conversation: ${state.threadUrl || buildThreadUrl(state.threadId) || "unknown"}`,
      `Thread ID: ${state.threadId || "unknown"}`,
      `Export date: ${new Date().toLocaleString()}`,
      `Exported messages: ${messages.length}`,
      `Scan complete: ${state.scanComplete ? "yes" : "no"}`,
      "",
      "----------------------------------------",
      "",
    ];

    return `${header.join("\n")}${messages.map(formatMessageForExport).join("\n\n")}\n`;
  }

  function contentTypeFromHeaders(headers) {
    const match = String(headers || "").match(/^content-type:\s*([^\r\n;]+)/im);
    return match?.[1]?.trim() || "";
  }

  function extensionFromContentType(contentType) {
    const mime = String(contentType || "").toLowerCase().split(";")[0].trim();
    const map = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
      "image/svg+xml": "svg",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
      "video/webm": "webm",
      "audio/mpeg": "mp3",
      "audio/mp4": "m4a",
      "audio/ogg": "ogg",
      "audio/wav": "wav",
      "application/pdf": "pdf",
    };

    return map[mime] || "";
  }

  function extensionFromUrl(url) {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
      return match ? match[1].toLowerCase() : "";
    } catch {
      return "";
    }
  }

  function getAssetExtension(url, contentType) {
    return extensionFromContentType(contentType) || extensionFromUrl(url) || "bin";
  }

  function getAssetBaseName(entry, index) {
    const messagePart = sanitizeFilenamePart(entry.messageId || `asset-${index + 1}`);
    const pathPart = sanitizeFilenamePart(entry.path || "media");
    return `${String(index + 1).padStart(4, "0")}-${messagePart}-${pathPart}`;
  }

  function getAssetDisplayName(entry) {
    try {
      const pathname = new URL(entry.url).pathname;
      const filename = pathname.split("/").filter(Boolean).pop();
      return filename || entry.path || "media";
    } catch {
      return entry.path || "media";
    }
  }

  function collectConversationAssets(messages) {
    const assets = [];
    const seen = new Set();

    for (const message of messages) {
      for (const entry of getMessageAssetEntries(message)) {
        if (seen.has(entry.url)) continue;
        seen.add(entry.url);
        assets.push({
          ...entry,
          messageId: message.message_id || message.id || "",
          timestampMs: message.timestamp_ms || "",
          sender: getSenderUsername(message),
        });
      }
    }

    return assets;
  }

  function buildAssetManifestEntry(entry, status, extra = {}) {
    return {
      url: entry.url,
      sourcePath: entry.path,
      messageId: entry.messageId,
      sender: entry.sender,
      timestampMs: entry.timestampMs,
      status,
      ...extra,
    };
  }

  async function runLimitedConcurrency(items, limit, worker) {
    if (!items.length) return [];

    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (!state.abortRequested) {
        const index = nextIndex;
        nextIndex++;

        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }));

    return results;
  }

  function fetchAssetArrayBuffer(url) {
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          responseType: "arraybuffer",
          timeout: ASSET_FETCH_TIMEOUT_MS,
          anonymous: false,
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              reject(new Error(`HTTP ${response.status}`));
              return;
            }

            resolve({
              arrayBuffer: response.response,
              contentType: contentTypeFromHeaders(response.responseHeaders),
            });
          },
          onerror: () => reject(new Error("media request failed")),
          ontimeout: () => reject(new Error("media request timed out")),
        });
      });
    }

    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller
      ? window.setTimeout(() => controller.abort(), ASSET_FETCH_TIMEOUT_MS)
      : null;

    return fetch(url, { credentials: "include", signal: controller?.signal }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return {
        arrayBuffer: await response.arrayBuffer(),
        contentType: response.headers.get("content-type") || "",
      };
    }).catch((error) => {
      if (error?.name === "AbortError") throw new Error("media request timed out");
      throw error;
    }).finally(() => {
      if (timeoutId) window.clearTimeout(timeoutId);
    });
  }

  function downloadBlobFile(filename, blob) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function sanitizeFilenamePart(value) {
    return String(value || "conversation")
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "conversation";
  }

  function getExportMessages() {
    return [...state.messages].sort((a, b) => timestampNumber(a) - timestampNumber(b));
  }

  function isImageAsset(asset) {
    const type = String(asset?.contentType || "").toLowerCase();
    const path = String(asset?.path || "").toLowerCase();
    return type.startsWith("image/") || /\.(apng|avif|gif|jpe?g|png|svg|webp|bmp)$/i.test(path);
  }

  function isVideoAsset(asset) {
    const type = String(asset?.contentType || "").toLowerCase();
    const path = String(asset?.path || "").toLowerCase();
    return type.startsWith("video/") || /\.(mp4|mov|m4v|webm)$/i.test(path);
  }

  function isAudioAsset(asset) {
    const type = String(asset?.contentType || "").toLowerCase();
    const path = String(asset?.path || "").toLowerCase();
    return type.startsWith("audio/") || /\.(mp3|m4a|ogg|wav)$/i.test(path);
  }

  function formatByteSize(bytes) {
    const value = Number(bytes || 0);
    if (!value) return "0 B";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderAssetHtml(entry, assetMap) {
    const asset = assetMap.get(entry.url);
    const title = escapeHtml(getAssetDisplayName(entry));
    const remoteLink = `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer">source link</a>`;

    if (!asset?.path) {
      const error = asset?.error ? ` · ${escapeHtml(asset.error)}` : "";
      return `<div class="asset asset-failed"><div class="asset-title">${title}</div><div class="muted">Not downloaded${error} · ${remoteLink}</div></div>`;
    }

    const localPath = escapeHtml(asset.path);
    const details = `${escapeHtml(asset.contentType || "file")} · ${escapeHtml(formatByteSize(asset.size))} · ${remoteLink}`;

    if (isImageAsset(asset)) {
      return `<figure class="asset"><img src="${localPath}" alt="${title}" loading="lazy"><figcaption>${title}<br><span class="muted">${details}</span></figcaption></figure>`;
    }

    if (isVideoAsset(asset)) {
      return `<figure class="asset"><video src="${localPath}" controls preload="metadata"></video><figcaption>${title}<br><span class="muted">${details}</span></figcaption></figure>`;
    }

    if (isAudioAsset(asset)) {
      return `<figure class="asset"><audio src="${localPath}" controls></audio><figcaption>${title}<br><span class="muted">${details}</span></figcaption></figure>`;
    }

    return `<div class="asset"><div class="asset-title">${title}</div><a href="${localPath}">Open local file</a><div class="muted">${details}</div></div>`;
  }

  function renderExternalLinksHtml(message) {
    const links = getMessageLinkEntries(message);
    if (!links.length) return "";

    return `
      <div class="links">
        <div class="section-label">Links</div>
        ${links.map((entry) => `<a href="${escapeHtml(entry.url)}" target="_blank" rel="noreferrer">${escapeHtml(entry.url)}</a>`).join("")}
      </div>
    `;
  }

  function buildConversationHtml(messages, assetMap, manifest) {
    const rows = messages.map((message) => {
      const sender = getSenderUsername(message);
      const senderId = getSenderAccountId(message);
      const text = getMessageExportContent(message);
      const assets = getMessageAssetEntries(message);
      const assetsHtml = assets.length
        ? `<div class="assets"><div class="section-label">Media and files</div>${assets.map((entry) => renderAssetHtml(entry, assetMap)).join("")}</div>`
        : "";

      return `
        <article class="message">
          <header>
            <div>
              <strong>${escapeHtml(sender)}</strong>
              ${senderId ? `<span class="muted">(${escapeHtml(senderId)})</span>` : ""}
            </div>
            <time>${escapeHtml(timestampToLocal(message.timestamp_ms) || "unknown date")}</time>
          </header>
          <div class="meta">
            <span>${escapeHtml(message.content_type || "unknown type")}</span>
            <span>${escapeHtml(message.message_id || "message without id")}</span>
          </div>
          <pre>${escapeHtml(text)}</pre>
          ${assetsHtml}
          ${renderExternalLinksHtml(message)}
        </article>
      `;
    }).join("\n");

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Instagram Direct - Conversation export</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --panel:#ffffff; --text:#111827; --muted:#667085; --line:#d9dee7; --accent:#2563eb; --danger:#b91c1c; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 980px; margin: 0 auto; padding: 28px 18px 48px; }
    h1 { margin: 0 0 6px; font-size: 24px; letter-spacing: 0; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
    .summary div, .message { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
    .summary div { padding: 12px; }
    .summary span, .muted { color: var(--muted); font-size: 12px; }
    .summary strong { display: block; margin-top: 4px; font-size: 18px; }
    .message { padding: 14px; margin: 12px 0; }
    .message header { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; border-bottom: 1px solid var(--line); padding-bottom: 8px; margin-bottom: 8px; }
    time { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; color: var(--muted); font-size: 12px; }
    .meta span { border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; background: #f8fafc; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: inherit; }
    .section-label { color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; margin: 14px 0 8px; }
    .assets { display: grid; gap: 10px; }
    .asset { border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin: 0; background: #fbfcfe; }
    .asset img, .asset video { display: block; max-width: 100%; max-height: 540px; border-radius: 6px; background: #111827; }
    .asset audio { width: 100%; }
    .asset figcaption { margin-top: 8px; overflow-wrap: anywhere; }
    .asset-title { font-weight: 700; overflow-wrap: anywhere; }
    .asset-failed { border-color: #fecaca; background: #fff7f7; }
    .links { display: grid; gap: 6px; overflow-wrap: anywhere; }
    a { color: var(--accent); }
    @media (max-width: 720px) {
      main { padding: 18px 10px 32px; }
      .summary { grid-template-columns: 1fr 1fr; }
      .message header { display: block; }
      time { display: block; margin-top: 4px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Instagram Direct - Conversation export</h1>
    <div class="muted">${escapeHtml(state.threadUrl || buildThreadUrl(state.threadId) || "unknown conversation")}</div>
    <section class="summary">
      <div><span>Messages</span><strong>${messages.length}</strong></div>
      <div><span>Media detected</span><strong>${manifest.assets.length}</strong></div>
      <div><span>Media included</span><strong>${manifest.assets.filter((asset) => asset.status === "included").length}</strong></div>
      <div><span>Scan complete</span><strong>${state.scanComplete ? "Yes" : "No"}</strong></div>
    </section>
    ${rows || "<p>No exported messages.</p>"}
  </main>
</body>
</html>`;
  }

  function buildExportManifest(messages, assets) {
    return {
      exportedAt: new Date().toISOString(),
      threadId: state.threadId || "",
      threadUrl: state.threadUrl || buildThreadUrl(state.threadId) || "",
      scanComplete: state.scanComplete,
      messageCount: messages.length,
      assetCount: assets.length,
      assetLimit: MAX_EXPORT_ASSETS,
      assetConcurrency: EXPORT_ASSET_CONCURRENCY,
      assetTimeoutMs: ASSET_FETCH_TIMEOUT_MS,
      maxAssetBytes: MAX_EXPORT_ASSET_BYTES,
      maxTotalAssetBytes: MAX_EXPORT_TOTAL_ASSET_BYTES,
      assets,
    };
  }

  function filterMessages(messages) {
    const settings = getEffectiveSettings();
    const messageId = state.settings.messageId.trim();
    const contentType = state.settings.contentType.trim().toUpperCase();
    const olderThanMs = state.settings.olderThan ? new Date(`${state.settings.olderThan}T23:59:59`).getTime() : null;
    const newerThanMs = state.settings.newerThan ? new Date(`${state.settings.newerThan}T00:00:00`).getTime() : null;

    if (state.settings.onlyOwn && !settings.userId) {
      throw new Error("Missing ds_user_id. Go to Credentials and click Auto-fill, or paste your .env/cookie.");
    }

    return messages.filter((message) => {
      const timestamp = Number.parseInt(String(message.timestamp_ms || "0"), 10);

      if (state.settings.onlyOwn && getSenderAccountId(message) !== settings.userId) return false;
      if (messageId && message.message_id !== messageId) return false;
      if (contentType && message.content_type !== contentType) return false;
      if (state.settings.hasText && !getMessageText(message)) return false;
      if (state.settings.hasMedia && message.content_type === "TEXT") return false;
      if (olderThanMs && timestamp > olderThanMs) return false;
      if (newerThanMs && timestamp < newerThanMs) return false;

      return true;
    });
  }

  function validateBeforeRequest() {
    const effective = getEffectiveSettings();
    const missing = [];

    if (!state.threadId) missing.push("conversation");
    if (!effective.csrftoken) missing.push("csrftoken");
    if (!effective.fbDtsg) missing.push("fb_dtsg");
    if (state.settings.onlyOwn && !effective.userId) missing.push("ds_user_id");

    if (missing.length) {
      throw new Error(
        `Missing values: ${missing.join(", ")}. Import the .env block or click Auto-fill, then open an Instagram Direct conversation.`
      );
    }
  }

  async function scanConversation() {
    collectFormValues();
    detectAndSetThread();
    validateBeforeRequest();

    state.running = true;
    state.abortRequested = false;
    state.messages = [];
    state.targetedMessages = [];
    state.scanComplete = false;
    state.stats = { loaded: 0, targeted: 0, deleted: 0, failed: 0 };
    render();

    const effective = getEffectiveSettings();
    let after = "";
    let hasMore = true;
    let page = 0;

    try {
      log(`Scan started for ${buildThreadUrl(state.threadId)}`);
      log(state.fetchTemplateCapture ? "Capture mode active." : "Direct mode active.");

      while (hasMore && !state.abortRequested) {
        page++;
        setStatus(`Loading page ${page}...`);

        const slideMessages = await fetchMessagesPage(state.threadId, after);
        const edges = slideMessages.edges || [];

        for (const edge of edges) {
          if (edge?.node) state.messages.push(edge.node);
        }

        state.targetedMessages = filterMessages(state.messages);
        state.stats.loaded = state.messages.length;
        state.stats.targeted = state.targetedMessages.length;
        updateStats();

        const pageInfo = slideMessages.page_info || {};
        hasMore = Boolean(pageInfo.has_next_page);
        after = pageInfo.end_cursor || "";
        log(`${state.messages.length} messages loaded, ${state.targetedMessages.length} targets.`);

        if (hasMore && !state.abortRequested) {
          await sleep(effective.pageDelayMs);
        }
      }

      state.scanComplete = !state.abortRequested;
      setStatus(state.abortRequested ? "Scan stopped." : "Scan complete.");
    } catch (error) {
      setStatus("Scan error.");
      throw error;
    } finally {
      state.running = false;
      render();
      updateStats();
    }
  }

  async function deleteTargetedMessages() {
    collectFormValues();
    validateBeforeRequest();

    if (!state.targetedMessages.length) {
      log("No targeted messages. Run a scan first.");
      return;
    }

    const count = state.targetedMessages.length;
    const confirmation = window.prompt(`Type DELETE to confirm ${count} deletion(s).`);
    if (confirmation !== "DELETE") {
      log("Deletion cancelled.");
      return;
    }

    state.running = true;
    state.abortRequested = false;
    render();

    const effective = getEffectiveSettings();

    try {
      for (const message of [...state.targetedMessages]) {
        if (state.abortRequested) break;

        const username = getSenderUsername(message);
        setStatus(`Deleting ${state.stats.deleted + state.stats.failed + 1}/${count}...`);
        log(`Deleting ${message.message_id} (${username})`);

        try {
          await deleteMessage(message);
          state.stats.deleted++;
          log(`Deleted: ${message.message_id}`);
        } catch (error) {
          state.stats.failed++;
          log(`Failed ${message.message_id}: ${error.message || error}`, "error");
        }

        updateStats();
        await sleep(effective.deleteDelayMs);
      }

      setStatus(state.abortRequested ? "Deletion stopped." : "Deletion complete.");
      log(`Result: ${state.stats.deleted} deleted, ${state.stats.failed} failed.`);
    } finally {
      state.running = false;
      render();
    }
  }

  async function scanThenDelete() {
    await scanConversation();
    if (!state.abortRequested) await deleteTargetedMessages();
  }

  function stopCurrentJob() {
    state.abortRequested = true;
    setStatus("Stop requested...");
    log("Stop requested.");
  }

  function detectAndSetThread() {
    const detected = detectThreadFromPage();

    if (detected.threadId) {
      state.threadId = detected.threadId;
      state.threadUrl = detected.threadUrl;
    }

    return detected;
  }

  function updateStats() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    for (const [key, value] of Object.entries(state.stats)) {
      const el = panel.querySelector(`[data-stat="${key}"]`);
      if (el) el.textContent = String(value);
    }
  }

  function applyEnvPaste() {
    const textarea = document.querySelector(`#${PANEL_ID} [name="envPaste"]`);
    const parsed = parseEnvBlock(textarea?.value || "");

    if (parsed.INSTAGRAM_CSRFTOKEN) state.settings.csrftoken = parsed.INSTAGRAM_CSRFTOKEN;
    if (parsed.INSTAGRAM_FB_DTSG) state.settings.fbDtsg = parsed.INSTAGRAM_FB_DTSG;
    if (parsed.INSTAGRAM_COOKIE) state.settings.cookie = parsed.INSTAGRAM_COOKIE;

    const cookies = parseCookieHeader(state.settings.cookie);
    if (cookies.get("csrftoken")) state.settings.csrftoken = cookies.get("csrftoken");
    if (cookies.get("ds_user_id")) state.settings.userId = cookies.get("ds_user_id");

    detectAndSetThread();
    log(".env block imported.");
    render();
  }

  function formatEnvBlock() {
    const effective = getEffectiveSettings();
    return [
      "# .env",
      `INSTAGRAM_CSRFTOKEN=${effective.csrftoken}`,
      `INSTAGRAM_COOKIE=${state.settings.cookie || document.cookie}`,
      `INSTAGRAM_FB_DTSG=${effective.fbDtsg}`,
    ].join("\n");
  }

  async function copyEnvBlock() {
    const env = formatEnvBlock();

    await gmSetClipboard(env);
    log(".env copied to clipboard.");
  }

  async function downloadAssetForZip(entry, index, assetsFolder, reserveAssetBytes) {
    try {
      const response = await fetchAssetArrayBuffer(entry.url);
      const contentType = response.contentType || "";
      const extension = getAssetExtension(entry.url, contentType);
      const filename = `${getAssetBaseName(entry, index)}.${extension}`;
      const path = `assets/${filename}`;
      const size = response.arrayBuffer?.byteLength || 0;

      if (size > MAX_EXPORT_ASSET_BYTES) {
        return buildAssetManifestEntry(entry, "skipped", {
          error: `Skipped because the media is ${formatByteSize(size)}. Per-file limit is ${formatByteSize(MAX_EXPORT_ASSET_BYTES)}.`,
          contentType,
          size,
        });
      }

      const reserveError = reserveAssetBytes?.(size);
      if (reserveError) {
        return buildAssetManifestEntry(entry, "skipped", {
          error: reserveError,
          contentType,
          size,
        });
      }

      assetsFolder.file(filename, response.arrayBuffer);

      return buildAssetManifestEntry(entry, "included", {
        path,
        contentType,
        size,
      });
    } catch (error) {
      return buildAssetManifestEntry(entry, "failed", {
        error: error.message || String(error),
      });
    }
  }

  async function exportConversationZip(options = {}) {
    const includeMedia = Boolean(options.includeMedia);

    collectFormValues();

    if (!state.messages.length) {
      log("No loaded messages. Run a scan before exporting a ZIP.");
      return;
    }

    const ZipCtor = typeof JSZip !== "undefined" ? JSZip : unsafeWindow?.JSZip;
    if (!ZipCtor) {
      throw new Error("JSZip is unavailable. Make sure the @require line is active in Tampermonkey.");
    }

    state.running = true;
    state.abortRequested = false;
    setStatus(includeMedia ? "Preparing ZIP export with media..." : "Preparing fast ZIP export...");
    render();

    const messages = getExportMessages();
    const allAssetEntries = collectConversationAssets(messages);
    const assetEntries = allAssetEntries.slice(0, MAX_EXPORT_ASSETS);
    const skippedAssetEntries = allAssetEntries.slice(MAX_EXPORT_ASSETS);
    const assetMap = new Map();
    const manifestAssets = [];
    const zip = new ZipCtor();
    const assetsFolder = includeMedia ? zip.folder("assets") : null;
    let includedAssetBytes = 0;
    const reserveAssetBytes = (size) => {
      if (includedAssetBytes + size > MAX_EXPORT_TOTAL_ASSET_BYTES) {
        return `Skipped because the ZIP media limit is ${formatByteSize(MAX_EXPORT_TOTAL_ASSET_BYTES)}.`;
      }

      includedAssetBytes += size;
      return "";
    };

    try {
      if (!includeMedia) {
        for (const entry of allAssetEntries) {
          const asset = buildAssetManifestEntry(entry, "linked", {
            error: "Fast export: media is kept as a source link and is not embedded in the ZIP.",
          });
          assetMap.set(entry.url, asset);
          manifestAssets.push(asset);
        }

        if (allAssetEntries.length) {
          log(`Fast ZIP export keeps ${allAssetEntries.length} media file(s) as source links.`);
        }
      } else {
        if (skippedAssetEntries.length) {
          log(
            `Media export limited to ${MAX_EXPORT_ASSETS}/${allAssetEntries.length} files. Skipped media remain available as source links.`
          );

          for (const entry of skippedAssetEntries) {
            const asset = buildAssetManifestEntry(entry, "skipped", {
              error: `Skipped by export limit (${MAX_EXPORT_ASSETS} media files).`,
            });
            assetMap.set(entry.url, asset);
            manifestAssets.push(asset);
          }
        }

        let completedAssets = 0;
        if (assetEntries.length) {
          setStatus(`Downloading media 0/${assetEntries.length}...`);
        }

        const downloadedAssets = await runLimitedConcurrency(
          assetEntries,
          EXPORT_ASSET_CONCURRENCY,
          async (entry, index) => {
            const asset = await downloadAssetForZip(entry, index, assetsFolder, reserveAssetBytes);
            completedAssets++;
            setStatus(`Downloading media ${completedAssets}/${assetEntries.length}...`);
            return asset;
          }
        );

        if (state.abortRequested) {
          log("ZIP export stopped.");
          setStatus("ZIP export stopped.");
          return;
        }

        for (const asset of downloadedAssets.filter(Boolean)) {
          assetMap.set(asset.url, asset);
          manifestAssets.push(asset);

          if (asset.status === "failed") {
            log(`Media not included: ${asset.url} (${asset.error})`, "error");
          } else if (asset.status === "skipped") {
            log(`Media skipped: ${asset.url} (${asset.error})`);
          }
        }
      }

      const manifest = buildExportManifest(messages, manifestAssets);
      const exportMeta = {
        exportedAt: manifest.exportedAt,
        threadId: manifest.threadId,
        threadUrl: manifest.threadUrl,
        scanComplete: manifest.scanComplete,
      };

      zip.file("index.html", buildConversationHtml(messages, assetMap, manifest));
      zip.file("conversation.txt", buildConversationTxt());
      zip.file("conversation.json", JSON.stringify({ ...exportMeta, messages }, null, 2));
      zip.file("manifest.json", JSON.stringify(manifest, null, 2));

      setStatus(includeMedia ? "Packaging ZIP with media..." : "Packaging fast ZIP...");
      const blob = await zip.generateAsync(
        {
          type: "blob",
          compression: "STORE",
          streamFiles: true,
        },
        (metadata) => {
          const percent = Math.round(metadata.percent);
          setStatus(includeMedia ? `Packaging ZIP with media ${percent}%...` : `Packaging fast ZIP ${percent}%...`);
        }
      );
      const mediaSuffix = includeMedia ? "-with-media" : "";
      const filename = `instagram-direct-${sanitizeFilenamePart(state.threadId)}${mediaSuffix}-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;

      downloadBlobFile(filename, blob);
      setStatus("ZIP export complete.");
      if (includeMedia) {
        log(
          `ZIP export downloaded: ${messages.length} messages, ` +
          `${manifestAssets.filter((asset) => asset.status === "included").length}/${allAssetEntries.length} media files included ` +
          `(${manifestAssets.filter((asset) => asset.status === "failed").length} failed, ` +
          `${manifestAssets.filter((asset) => asset.status === "skipped").length} skipped).`
        );
      } else {
        log(`Fast ZIP export downloaded: ${messages.length} messages, ${allAssetEntries.length} media source links.`);
      }
    } finally {
      state.running = false;
      render();
      updateStats();
    }
  }

  function renderButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.textContent = "IG Direct";
    button.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483646",
      "background:#111827",
      "color:#f8fafc",
      "border:1px solid rgba(148,163,184,.42)",
      "border-radius:8px",
      "padding:9px 12px",
      "font:600 12px system-ui,sans-serif",
      "box-shadow:0 10px 24px rgba(0,0,0,.26)",
      "cursor:pointer",
    ].join(";");

    button.addEventListener("click", () => {
      state.open = true;
      render();
    });

    document.body.appendChild(button);
  }

  function styleBlock() {
    return `
      <style>
        #${PANEL_ID}, #${PANEL_ID} * { box-sizing: border-box; }
        #${PANEL_ID} {
          position: fixed;
          max-height: calc(100vh - 32px);
          z-index: 2147483647;
          background: #0f141d;
          color: #f8fafc;
          border: 1px solid rgba(148, 163, 184, .32);
          border-radius: 8px;
          box-shadow: 0 24px 64px rgba(0,0,0,.42);
          font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          overflow: hidden;
          backdrop-filter: blur(14px);
        }
        #${PANEL_ID} button, #${PANEL_ID} input, #${PANEL_ID} textarea, #${PANEL_ID} select {
          font: inherit;
        }
        #${PANEL_ID}.detached {
          resize: both;
          min-width: 360px;
          min-height: 360px;
        }
        #${PANEL_ID} .igdd-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          padding: 14px 16px;
          border-bottom: 1px solid rgba(148, 163, 184, .22);
          background: #151b26;
        }
        #${PANEL_ID} .igdd-drag-handle {
          flex: 1;
          min-width: 0;
          cursor: grab;
          user-select: none;
        }
        #${PANEL_ID} .igdd-drag-handle:active { cursor: grabbing; }
        #${PANEL_ID} .igdd-title {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 14px;
          font-weight: 700;
          letter-spacing: 0;
        }
        #${PANEL_ID} .igdd-window-actions { display: flex; gap: 8px; align-items: center; }
        #${PANEL_ID} .igdd-icon-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          border: 1px solid rgba(148, 163, 184, .32);
          background: #111827;
          color: #f8fafc;
          border-radius: 8px;
          cursor: pointer;
        }
        #${PANEL_ID} .igdd-icon-button:hover { background: #1f2937; border-color: rgba(191, 219, 254, .45); }
        #${PANEL_ID} .igdd-muted { color: #aab4c4; font-size: 12px; }
        #${PANEL_ID} .igdd-subtitle {
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        #${PANEL_ID} .igdd-body {
          padding: 14px;
          overflow: auto;
          max-height: calc(100vh - 104px);
        }
        #${PANEL_ID} .igdd-tabs {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 4px;
          margin-bottom: 12px;
          padding: 4px;
          border: 1px solid rgba(148, 163, 184, .24);
          background: #111827;
          border-radius: 8px;
        }
        #${PANEL_ID} .igdd-tab, #${PANEL_ID} .igdd-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 7px;
          border: 1px solid rgba(148, 163, 184, .30);
          background: #1f2937;
          color: #f8fafc;
          border-radius: 7px;
          padding: 8px 11px;
          cursor: pointer;
          min-height: 36px;
        }
        #${PANEL_ID} .igdd-tab { border-color: transparent; background: transparent; }
        #${PANEL_ID} .igdd-tab:hover, #${PANEL_ID} .igdd-button:hover {
          border-color: rgba(191, 219, 254, .48);
          background: #273449;
        }
        #${PANEL_ID} .igdd-tab.active, #${PANEL_ID} .igdd-primary {
          background: #2563eb;
          border-color: #3b82f6;
          color: #fff;
          box-shadow: none;
        }
        #${PANEL_ID} .igdd-danger {
          background: #b91c1c;
          border-color: #dc2626;
          color: #fff;
        }
        #${PANEL_ID} .igdd-button:disabled { opacity: .55; cursor: not-allowed; }
        #${PANEL_ID} .igdd-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
        #${PANEL_ID} .igdd-field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
        #${PANEL_ID} label { color: #d6def0; font-weight: 700; font-size: 12px; }
        #${PANEL_ID} input, #${PANEL_ID} textarea, #${PANEL_ID} select {
          width: 100%;
          background: #0b1120;
          color: #f8fafc;
          border: 1px solid rgba(148, 163, 184, .30);
          border-radius: 7px;
          padding: 8px 9px;
          outline: none;
        }
        #${PANEL_ID} input:focus, #${PANEL_ID} textarea:focus, #${PANEL_ID} select:focus {
          border-color: rgba(96, 165, 250, .76);
          box-shadow: 0 0 0 2px rgba(59, 130, 246, .20);
        }
        #${PANEL_ID} textarea { min-height: 86px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
        #${PANEL_ID} .igdd-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        #${PANEL_ID} .igdd-card {
          border: 1px solid rgba(148, 163, 184, .22);
          background: #151b26;
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 12px;
        }
        #${PANEL_ID} .igdd-section-title {
          color: #f8fafc;
          font-size: 12px;
          font-weight: 700;
          margin: 0 0 10px;
          text-transform: uppercase;
          letter-spacing: .04em;
        }
        #${PANEL_ID} .igdd-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
        #${PANEL_ID} .igdd-stat {
          background: #0b1120;
          border: 1px solid rgba(148, 163, 184, .22);
          border-radius: 8px;
          padding: 10px;
        }
        #${PANEL_ID} .igdd-stat strong { display:block; font-size: 20px; margin-top: 2px; }
        #${PANEL_ID} .igdd-preview { width: 100%; border-collapse: collapse; font-size: 12px; }
        #${PANEL_ID} .igdd-preview th, #${PANEL_ID} .igdd-preview td { border-bottom: 1px solid rgba(148, 163, 184, .16); padding: 8px 6px; vertical-align: top; text-align: left; }
        #${PANEL_ID} .igdd-preview th { color: #b8c2d6; font-weight: 700; }
        #${PANEL_ID} .igdd-preview td { color: #e7ecf7; }
        #${PANEL_ID} .igdd-logs {
          white-space: pre-wrap;
          min-height: 260px;
          max-height: 430px;
          overflow: auto;
          background: #0b1120;
          border: 1px solid rgba(148, 163, 184, .22);
          border-radius: 8px;
          padding: 12px;
          color: #d4dbea;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12px;
        }
        #${PANEL_ID} .igdd-check { flex-direction: row; align-items: center; gap: 8px; }
        #${PANEL_ID} .igdd-check input { width: auto; accent-color: #2563eb; }
        @media (max-width: 680px) {
          #${PANEL_ID} {
            left: 8px !important;
            right: 8px !important;
            top: 8px !important;
            width: auto !important;
            transform: none !important;
            max-height: calc(100vh - 16px);
          }
          #${PANEL_ID} .igdd-body { max-height: calc(100vh - 92px); }
          #${PANEL_ID} .igdd-grid, #${PANEL_ID} .igdd-stats { grid-template-columns: 1fr; }
          #${PANEL_ID} .igdd-tabs { grid-template-columns: 1fr; }
        }
      </style>
    `;
  }

  function tabButton(id, label) {
    return `<button class="igdd-tab ${state.activeTab === id ? "active" : ""}" data-tab="${id}">${label}</button>`;
  }

  function field(name, label, options = {}) {
    const value = state.settings[name] ?? "";
    const type = options.type || "text";
    const placeholder = options.placeholder || "";

    if (type === "textarea") {
      return `
        <div class="igdd-field" style="${options.full ? "grid-column:1/-1;" : ""}">
          <label for="igdd-${name}">${label}</label>
          <textarea id="igdd-${name}" name="${name}" placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>
        </div>
      `;
    }

    if (type === "checkbox") {
      return `
        <label class="igdd-field igdd-check">
          <input type="checkbox" name="${name}" ${value ? "checked" : ""}>
          <span>${label}</span>
        </label>
      `;
    }

    return `
      <div class="igdd-field" style="${options.full ? "grid-column:1/-1;" : ""}">
        <label for="igdd-${name}">${label}</label>
        <input id="igdd-${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}">
      </div>
    `;
  }

  function runTab() {
    const threadValue = state.threadUrl || buildThreadUrl(state.threadId) || "";
    const captureStatus = state.fetchTemplateCapture
      ? "Capture mode is active: the detected Instagram request will be reused."
      : "Direct mode: the script uses the configured doc_id values.";
    const previewRows = state.targetedMessages.slice(0, 12).map((message) => `
      <tr>
        <td>${escapeHtml(timestampToLocal(message.timestamp_ms))}</td>
        <td>${escapeHtml(getSenderUsername(message))}</td>
        <td>${escapeHtml(message.content_type || "")}</td>
        <td>${escapeHtml(shortText(getMessageText(message), 80))}</td>
      </tr>
    `).join("");

    return `
      <div class="igdd-card">
        <div class="igdd-section-title">Conversation</div>
        <div class="igdd-grid">
          <div class="igdd-field" style="grid-column:1/-1;">
            <label>Detected conversation</label>
            <input name="threadInput" value="${escapeHtml(threadValue)}" placeholder="https://www.instagram.com/direct/t/.../">
          </div>
        </div>
        <div class="igdd-row" style="margin-top:10px;">
          <button class="igdd-button" data-action="detect-thread">Detect conversation</button>
          <button class="igdd-button" data-action="copy-env">Copy .env</button>
        </div>
        <div class="igdd-muted" style="margin-top:8px;">${escapeHtml(captureStatus)}</div>
      </div>

      <div class="igdd-card">
        <div class="igdd-section-title">Filters</div>
        <div class="igdd-grid">
          ${field("onlyOwn", "Target only my messages", { type: "checkbox" })}
          ${field("messageId", "Message ID")}
          ${field("contentType", "Type", { placeholder: "TEXT" })}
          ${field("olderThan", "Before", { type: "date" })}
          ${field("newerThan", "After", { type: "date" })}
          ${field("hasText", "Has text", { type: "checkbox" })}
          ${field("hasMedia", "Has media", { type: "checkbox" })}
        </div>
      </div>

      <div class="igdd-card">
        <div class="igdd-section-title">Actions</div>
        <div class="igdd-stats">
          <div class="igdd-stat"><span class="igdd-muted">Loaded</span><strong data-stat="loaded">${state.stats.loaded}</strong></div>
          <div class="igdd-stat"><span class="igdd-muted">Targets</span><strong data-stat="targeted">${state.stats.targeted}</strong></div>
          <div class="igdd-stat"><span class="igdd-muted">Deleted</span><strong data-stat="deleted">${state.stats.deleted}</strong></div>
          <div class="igdd-stat"><span class="igdd-muted">Failed</span><strong data-stat="failed">${state.stats.failed}</strong></div>
        </div>
        <div class="igdd-row" style="margin-top:10px;">
          <button class="igdd-button igdd-primary" data-action="scan" ${state.running ? "disabled" : ""}>Scan</button>
          <button class="igdd-button igdd-danger" data-action="delete" ${state.running ? "disabled" : ""}>Delete targets</button>
          <button class="igdd-button igdd-danger" data-action="scan-delete" ${state.running ? "disabled" : ""}>Scan + delete</button>
          <button class="igdd-button" data-action="export-zip" ${state.running || !state.messages.length ? "disabled" : ""}>Export ZIP</button>
          <button class="igdd-button" data-action="export-zip-media" ${state.running || !state.messages.length ? "disabled" : ""}>Export ZIP + media</button>
          <button class="igdd-button" data-action="stop" ${state.running ? "" : "disabled"}>Stop</button>
        </div>
        <div class="igdd-muted" style="margin-top:8px;" data-role="status">${escapeHtml(state.status)}</div>
      </div>

      <div class="igdd-card">
        <div class="igdd-section-title">Target preview</div>
        <table class="igdd-preview">
          <thead><tr><th>Date</th><th>Account</th><th>Type</th><th>Content</th></tr></thead>
          <tbody>${previewRows || `<tr><td colspan="4" class="igdd-muted">No targeted messages yet.</td></tr>`}</tbody>
        </table>
      </div>
    `;
  }

  function credentialsTab() {
    const effective = getEffectiveSettings();
    const detected = [
      effective.csrftoken ? "csrftoken OK" : "csrftoken missing",
      effective.fbDtsg ? "fb_dtsg OK" : "fb_dtsg missing",
      effective.userId ? `ds_user_id ${effective.userId}` : "ds_user_id missing",
      state.threadId ? `thread ${state.threadId}` : "conversation not detected",
      state.fetchTemplateCapture ? "capture mode" : "direct mode",
    ].join(" | ");

    return `
      <div class="igdd-card">
        <div class="igdd-section-title">Credentials</div>
        <label for="igdd-envPaste">.env block</label>
        <textarea id="igdd-envPaste" name="envPaste" style="min-height:180px;" placeholder="INSTAGRAM_CSRFTOKEN=...&#10;INSTAGRAM_COOKIE=...&#10;INSTAGRAM_FB_DTSG=...">${escapeHtml(formatEnvBlock())}</textarea>
        <div class="igdd-row" style="margin-top:10px;">
          <button class="igdd-button igdd-primary" data-action="import-env">Import .env</button>
          <button class="igdd-button" data-action="autofill">Auto-fill</button>
          <button class="igdd-button" data-action="copy-env">Copy .env</button>
          <button class="igdd-button" data-action="clear">Clear</button>
        </div>
        <div class="igdd-muted" style="margin-top:8px;">
          ${escapeHtml(detected)}
        </div>
      </div>

      <div class="igdd-card">
        <div class="igdd-muted">
          The expected format only contains the .env credentials. The conversation is detected automatically from the open Instagram Direct URL.
        </div>
      </div>
    `;
  }

  function logsTab() {
    return `
      <div class="igdd-card">
        <div class="igdd-section-title">Logs</div>
        <div class="igdd-row" style="margin-bottom:10px;">
          <button class="igdd-button" data-action="clear-logs">Clear logs</button>
        </div>
        <pre class="igdd-logs" data-role="logs">${escapeHtml(formatLogs())}</pre>
      </div>
    `;
  }

  function currentTabContent() {
    if (state.activeTab === "credentials") return credentialsTab();
    if (state.activeTab === "logs") return logsTab();
    return runTab();
  }

  function render() {
    if (!document.body) return;

    collectFormValues();
    renderButton();

    const existing = document.getElementById(PANEL_ID);
    if (!state.open) {
      existing?.remove();
      return;
    }

    if (!state.threadId) detectAndSetThread();

    const detachIcon = state.ui.detached ? "⌖" : "↗";
    const detachTitle = state.ui.detached ? "Recenter window" : "Detach window";
    const windowMode = state.ui.detached ? "Detached window" : "Modal window";
    const html = `
      ${styleBlock()}
      <div class="igdd-header">
        <div class="igdd-drag-handle" data-role="drag-handle" title="Drag to detach and move">
          <div class="igdd-title">Instagram Direct Deleter</div>
          <div class="igdd-muted igdd-subtitle">${escapeHtml(state.threadUrl || "No conversation detected")} · ${escapeHtml(windowMode)}</div>
        </div>
        <div class="igdd-window-actions">
          <button class="igdd-icon-button" data-action="toggle-detach" title="${escapeHtml(detachTitle)}">${detachIcon}</button>
          <button class="igdd-icon-button" data-action="close" title="Close">×</button>
        </div>
      </div>
      <div class="igdd-body">
        <div class="igdd-tabs">
          ${tabButton("run", "Scan")}
          ${tabButton("credentials", "Credentials")}
          ${tabButton("logs", "Logs")}
        </div>
        ${currentTabContent()}
      </div>
    `;

    const panel = existing || document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = state.ui.detached ? "detached" : "modal";
    panel.style.cssText = getPanelPositionStyle();
    panel.innerHTML = html;

    if (!existing) {
      document.body.appendChild(panel);
    }

    attachPanelEvents();
    attachDragEvents();
    updateStats();
  }

  async function toggleDetachMode() {
    const panel = document.getElementById(PANEL_ID);

    if (state.ui.detached) {
      state.ui.detached = false;
    } else {
      const rect = panel?.getBoundingClientRect();
      const position = clampPanelPosition(rect?.left || DEFAULT_UI.x, rect?.top || DEFAULT_UI.y);

      state.ui.detached = true;
      state.ui.x = position.x;
      state.ui.y = position.y;
      state.ui.width = clampNumber(rect?.width || DEFAULT_UI.width, 360, Math.max(360, window.innerWidth - 24));
    }

    await saveUiState();
    render();
  }

  function attachDragEvents() {
    const panel = document.getElementById(PANEL_ID);
    const handle = panel?.querySelector('[data-role="drag-handle"]');
    if (!panel || !handle) return;

    handle.addEventListener("pointerdown", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.button !== 0 || target?.closest("button,input,textarea,select")) return;

      const rect = panel.getBoundingClientRect();
      const startOffsetX = event.clientX - rect.left;
      const startOffsetY = event.clientY - rect.top;

      state.ui.detached = true;
      state.ui.width = clampNumber(rect.width, 360, Math.max(360, window.innerWidth - 24));
      state.ui.x = rect.left;
      state.ui.y = rect.top;
      applyPanelPosition();

      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();

      const movePanel = (moveEvent) => {
        const position = clampPanelPosition(
          moveEvent.clientX - startOffsetX,
          moveEvent.clientY - startOffsetY
        );

        state.ui.x = position.x;
        state.ui.y = position.y;
        applyPanelPosition();
      };

      const stopDrag = () => {
        const resizedRect = panel.getBoundingClientRect();
        state.ui.width = clampNumber(resizedRect.width, 360, Math.max(360, window.innerWidth - 24));
        handle.releasePointerCapture?.(event.pointerId);
        window.removeEventListener("pointermove", movePanel);
        window.removeEventListener("pointerup", stopDrag);
        window.removeEventListener("pointercancel", stopDrag);
        void saveUiState();
      };

      window.addEventListener("pointermove", movePanel);
      window.addEventListener("pointerup", stopDrag);
      window.addEventListener("pointercancel", stopDrag);
    });
  }

  function attachPanelEvents() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    panel.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        collectFormValues();
        state.activeTab = button.getAttribute("data-tab") || "run";
        render();
      });
    });

    panel.querySelectorAll("input, textarea, select").forEach((field) => {
      field.addEventListener("change", () => collectFormValues());
      field.addEventListener("input", () => collectFormValues());
    });

    panel.querySelectorAll("[data-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.getAttribute("data-action");

        try {
          switch (action) {
            case "close":
              collectFormValues();
              state.open = false;
              render();
              break;
            case "toggle-detach":
              await toggleDetachMode();
              break;
            case "detect-thread":
              detectAndSetThread();
              log(state.threadId ? `Conversation detected: ${state.threadId}` : "No conversation detected.");
              render();
              break;
            case "autofill":
              applyCapturedCredentials(true);
              log("Credentials auto-filled from the page/capture.");
              await gmSetValue(STORAGE_KEY, state.settings);
              log("Credentials saved.");
              render();
              break;
            case "save":
              await saveSettings();
              break;
            case "clear":
              await clearSettings();
              break;
            case "import-env":
              applyEnvPaste();
              await gmSetValue(STORAGE_KEY, state.settings);
              log("Credentials saved.");
              break;
            case "copy-env":
              await copyEnvBlock();
              break;
            case "export-zip":
              await exportConversationZip({ includeMedia: false });
              break;
            case "export-zip-media":
              await exportConversationZip({ includeMedia: true });
              break;
            case "scan":
              await scanConversation();
              break;
            case "delete":
              await deleteTargetedMessages();
              break;
            case "scan-delete":
              await scanThenDelete();
              break;
            case "stop":
              stopCurrentJob();
              break;
            case "clear-logs":
              state.logs = [];
              render();
              break;
          }
        } catch (error) {
          log(error.message || error, "error");
          setStatus("Error.");
        }
      });
    });
  }

  function attachNavigationListener() {
    let lastPathname = location.pathname;
    const refresh = () => {
      if (location.pathname === lastPathname) return;

      lastPathname = location.pathname;
      const previousThreadId = state.threadId;
      const detected = detectAndSetThread();
      if (detected.threadId && detected.threadId !== previousThreadId) {
        log(`Conversation detected: ${detected.threadId}`);
      }
      render();
    };

    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      history[method] = function patchedHistoryMethod() {
        const result = original.apply(this, arguments);
        window.setTimeout(refresh, 100);
        return result;
      };
    }

    window.addEventListener("popstate", () => window.setTimeout(refresh, 100));
    window.setInterval(refresh, 1000);
  }

  function attachCaptureListener() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== CAPTURE_EVENT_NAME || !event.data.capture) return;

      state.latestCapture = event.data.capture;
      const templateType = rememberGraphQLTemplate(state.latestCapture);
      applyCapturedCredentials(false);

      const friendlyName = getCaptureFriendlyName(state.latestCapture);
      if (templateType === "message-list") {
        log(`Message request captured: ${friendlyName || "GraphQL"}`);
      } else if (templateType === "unsend") {
        log(`Delete request captured: ${friendlyName || "GraphQL"}`);
      } else if (friendlyName) {
        log(`Capture GraphQL: ${friendlyName}`);
      }

      if (state.open && state.activeTab === "credentials") render();
    });
  }

  function normalizeRequestHeaders(input, targetWindow = window) {
    if (!input) return {};

    const HeadersCtor = targetWindow.Headers || window.Headers;
    if (HeadersCtor && input instanceof HeadersCtor) {
      return Object.fromEntries(input.entries());
    }

    if (Array.isArray(input)) return Object.fromEntries(input);
    return { ...input };
  }

  function emitCapture(capture) {
    window.postMessage({ type: CAPTURE_EVENT_NAME, capture }, "*");
  }

  function installWindowInterceptor(targetWindow, sourceName) {
    if (!targetWindow) return false;

    let installed = false;

    try {
      const originalFetch = targetWindow.fetch;
      if (typeof originalFetch === "function" && !targetWindow.__igDirectDeleterFetchPatched) {
        targetWindow.__igDirectDeleterFetchPatched = true;
        targetWindow.fetch = function patchedFetch(input, init) {
          const url = typeof input === "string" ? input : input?.url || "";
          const method = init?.method || (typeof input !== "string" ? input?.method : "") || "GET";
          const headers = normalizeRequestHeaders(
            init?.headers || (typeof input !== "string" ? input?.headers : undefined),
            targetWindow
          );
          const body = init?.body || "";

          if (String(url).includes(GRAPHQL_PATH) && String(method).toUpperCase() === "POST") {
            emitCapture({
              transport: `${sourceName}:fetch`,
              url,
              method,
              headers,
              body: typeof body === "string" ? body : String(body || ""),
              capturedAt: new Date().toISOString(),
            });
          }

          return originalFetch.apply(this, arguments);
        };
        installed = true;
      }

      const xhrProto = targetWindow.XMLHttpRequest?.prototype;
      if (xhrProto && !targetWindow.__igDirectDeleterXhrPatched) {
        targetWindow.__igDirectDeleterXhrPatched = true;
        const originalOpen = xhrProto.open;
        const originalSetRequestHeader = xhrProto.setRequestHeader;
        const originalSend = xhrProto.send;

        xhrProto.open = function patchedOpen(method, url) {
          this.__igddMethod = method;
          this.__igddUrl = url;
          this.__igddHeaders = {};
          return originalOpen.apply(this, arguments);
        };

        xhrProto.setRequestHeader = function patchedSetRequestHeader(name, value) {
          this.__igddHeaders = this.__igddHeaders || {};
          this.__igddHeaders[name] = value;
          return originalSetRequestHeader.apply(this, arguments);
        };

        xhrProto.send = function patchedSend(body) {
          const url = this.__igddUrl || "";
          const method = this.__igddMethod || "GET";

          if (String(url).includes(GRAPHQL_PATH) && String(method).toUpperCase() === "POST") {
            emitCapture({
              transport: `${sourceName}:xhr`,
              url,
              method,
              headers: this.__igddHeaders || {},
              body: typeof body === "string" ? body : String(body || ""),
              capturedAt: new Date().toISOString(),
            });
          }

          return originalSend.apply(this, arguments);
        };
        installed = true;
      }
    } catch (error) {
      log(`Could not install ${sourceName} interception: ${error.message || error}`, "error");
    }

    return installed;
  }

  function installUnsafeWindowInterceptor() {
    const targetWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const installed = installWindowInterceptor(targetWindow, targetWindow === window ? "window" : "unsafeWindow");
    if (installed) log("Fetch/XHR interception active.");
    return installed;
  }

  function injectInterceptor() {
    const script = document.createElement("script");
    script.textContent = `
      (() => {
        const GRAPHQL_PATH = ${JSON.stringify(GRAPHQL_PATH)};
        const CAPTURE_EVENT_NAME = ${JSON.stringify(CAPTURE_EVENT_NAME)};

        function normalizeHeaders(input) {
          if (!input) return {};
          if (typeof Headers !== "undefined" && input instanceof Headers) {
            return Object.fromEntries(input.entries());
          }
          if (Array.isArray(input)) return Object.fromEntries(input);
          return { ...input };
        }

        function emitCapture(capture) {
          window.postMessage({ type: CAPTURE_EVENT_NAME, capture }, "*");
        }

        const originalFetch = window.fetch;
        if (typeof originalFetch === "function" && !window.__igDirectDeleterFetchPatched) {
          window.__igDirectDeleterFetchPatched = true;
          window.fetch = async function patchedFetch(input, init) {
            const url = typeof input === "string" ? input : input?.url || "";
            const method = init?.method || (typeof input !== "string" ? input?.method : "") || "GET";
            const headers = normalizeHeaders(init?.headers || (typeof input !== "string" ? input?.headers : undefined));
            const body = init?.body || "";

            if (String(url).includes(GRAPHQL_PATH) && String(method).toUpperCase() === "POST") {
              emitCapture({
                transport: "fetch",
                url,
                method,
                headers,
                body: typeof body === "string" ? body : String(body || ""),
                capturedAt: new Date().toISOString(),
              });
            }

            return originalFetch.apply(this, arguments);
          };
        }

        if (!window.__igDirectDeleterXhrPatched) {
          window.__igDirectDeleterXhrPatched = true;
          const originalOpen = XMLHttpRequest.prototype.open;
          const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
          const originalSend = XMLHttpRequest.prototype.send;

          XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
            this.__igddMethod = method;
            this.__igddUrl = url;
            this.__igddHeaders = {};
            return originalOpen.apply(this, arguments);
          };

          XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
            this.__igddHeaders = this.__igddHeaders || {};
            this.__igddHeaders[name] = value;
            return originalSetRequestHeader.apply(this, arguments);
          };

          XMLHttpRequest.prototype.send = function patchedSend(body) {
            const url = this.__igddUrl || "";
            const method = this.__igddMethod || "GET";

            if (String(url).includes(GRAPHQL_PATH) && String(method).toUpperCase() === "POST") {
              emitCapture({
                transport: "xhr",
                url,
                method,
                headers: this.__igddHeaders || {},
                body: typeof body === "string" ? body : String(body || ""),
                capturedAt: new Date().toISOString(),
              });
            }

            return originalSend.apply(this, arguments);
          };
        }
      })();
    `;

    const target = document.documentElement || document.head;
    if (!target) return;
    target.appendChild(script);
    script.remove();
  }

  async function waitForBody() {
    if (document.body) return;

    await new Promise((resolve) => {
      const done = () => {
        if (!document.body) return;
        document.removeEventListener("DOMContentLoaded", done);
        window.removeEventListener("load", done);
        resolve();
      };

      document.addEventListener("DOMContentLoaded", done);
      window.addEventListener("load", done);
    });
  }

  async function init() {
    state.settings = normalizeSettings(await gmGetValue(STORAGE_KEY, {}));
    state.ui = {
      ...DEFAULT_UI,
      ...(await gmGetValue(UI_STORAGE_KEY, {})),
    };

    attachCaptureListener();
    attachNavigationListener();
    installUnsafeWindowInterceptor();
    injectInterceptor();
    await waitForBody();
    detectAndSetThread();
    render();
    log("Extension ready.");
  }

  await init();
})();
