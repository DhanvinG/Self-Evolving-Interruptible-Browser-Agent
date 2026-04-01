console.log("[background] service worker loaded");

importScripts("prompts.js", "llmClient.js");

const MSG_TYPES = {
  START_AGENT: "START_AGENT",
  OBSERVE_SHOW: "OBSERVE_SHOW",
  OBSERVE_HIDE: "OBSERVE_HIDE",
  EXEC_ACTION: "EXEC_ACTION",
  DEBUG_LOG: "DEBUG_LOG",
};

const MAX_STEPS = 30;
const MAX_CONSECUTIVE_SCROLLS = 6;
const POST_ACTION_DELAY_MS = 250;
const MAX_HISTORY_ENTRIES = 5;
const MAX_SCRATCHPAD_LENGTH = 1800;
const MAX_CONTROLLER_FAILURES = 3;
const DEBUG_CONTROLLER = true;
const DEBUG_STRING_LIMIT = 500;
const DEBUG_ARRAY_LIMIT = 12;
const MANUAL_OVERLAY_REFRESH_SCHEDULE_MS = [150, 400, 800, 1400];
let isAgentRunning = false;
let activeAgentTabId = null;
let activeAgentMode = null;
let activeAgentRunToken = 0;
let manualOverlayMode = false;
let manualOverlayTabId = null;
let manualOverlayRefreshToken = 0;
let manualOverlayFollowUntil = 0;
const voiceState = {
  sessionActive: false,
  processingActive: false,
  listeningActive: false,
  captureMode: null,
  sessionTabId: null,
  targetTabId: null,
};
const pendingSummarySessionTabs = new Set();
let pendingUserReplyResolver = null;
const sessionState = new Map(); // per-tab state

const SUMMARIZE_ENDPOINT = "http://localhost:8000/summarize"; // placeholder; adjust as needed
const INTENT_ENDPOINT = "http://localhost:8000/intent"; // simple command intent classifier

// TODO: Stage 2 - wire wake-word/ASR via offscreen page when ready.

// Simple personalization profile used to auto-fill forms/emails.
const USER_PROFILE = {
  name: "Alex Chen",
  email: "alex.chen.dev@gmail.com",
  phone: "+1-415-867-3921",
  role: "Software Engineer",
  company: "Stripe",
  school: "University of California, Berkeley",
  skills: [
    "JavaScript",
    "TypeScript",
    "React",
    "Node.js",
    "Python",
    "AI Agents",
    "Distributed Systems"
  ],
  bio: "Software engineer at Stripe focused on building scalable, user-centered products at the intersection of AI and web platforms. Passionate about clean system design, low-latency experiences, and turning complex workflows into intuitive tools. Always experimenting, shipping, and iterating."
};

const SMALL_LLM_API_KEY = null; // set to your OpenAI API key if desired
const SMALL_LLM_MODEL = "gpt-4o-mini";
const PROFILE_ANSWER_ENDPOINT = "http://localhost:8000/profile-answer";
const TTS_ENDPOINT = "http://localhost:8000/tts";
const TTS_VOICE = "marin";
const SPOKEN_NUMBER_UNITS = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const SPOKEN_NUMBER_TENS = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

function answerFromProfile(question = "") {
  const q = (question || "").toLowerCase();
  const fields = [
    { key: "name", aliases: ["name"] },
    { key: "email", aliases: ["email", "e-mail"] },
    { key: "phone", aliases: ["phone", "phone number", "mobile"] },
    { key: "role", aliases: ["role", "title", "job title", "position"] },
    { key: "company", aliases: ["company", "employer", "organization"] },
    { key: "school", aliases: ["school", "university", "college"] },
    { key: "bio", aliases: ["bio", "background"] },
    { key: "skills", aliases: ["skills", "skillset"] },
  ];

  for (const f of fields) {
    const val = USER_PROFILE[f.key];
    if (!val || (Array.isArray(val) && val.length === 0)) continue;
    for (const alias of f.aliases) {
      if (q.includes(alias)) {
        if (Array.isArray(val)) {
          return val.join(", ");
        }
        return String(val);
      }
    }
  }
  return null;
}

// Non-streaming TTS: fetch a data URL and return it.
async function speakText(text = "") {
  if (!text) return null;
  try {
    const res = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: TTS_VOICE }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const audioUrl = data && data.audio;
    return typeof audioUrl === "string" ? audioUrl : null;
  } catch (err) {
    console.warn("[tts] failed:", err?.message || err);
    return null;
  }
}

function normalizeQuestionKey(q = "") {
  return q.toLowerCase().trim();
}

async function askSmallProfileLLM(question = "") {
  try {
    const res = await fetch(PROFILE_ANSWER_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question || "", user_profile: USER_PROFILE }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ans = data && data.answer;
    if (typeof ans !== "string") return null;
    return ans.trim();
  } catch (err) {
    console.warn("[profile-llm] failed:", err?.message || err);
    return null;
  }
}

async function autoAnswerAskUser(question = "", askCache = null) {
  const key = normalizeQuestionKey(question);
  if (askCache && askCache[key]) return askCache[key];

  const auto = await askSmallProfileLLM(question || "");
  if (auto) {
    const upper = auto.toUpperCase().trim();
    if (upper !== "UNKNOWN") {
      if (askCache) askCache[key] = auto;
      return auto;
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextNonTaskAgentRunToken() {
  activeAgentRunToken += 1;
  return activeAgentRunToken;
}

function invalidateNonTaskAgentRuns() {
  activeAgentRunToken += 1;
  return activeAgentRunToken;
}

function isCurrentNonTaskAgentRun(runToken) {
  return typeof runToken === "number" && activeAgentRunToken === runToken;
}

function shouldStopNonTaskAgentRun(runToken) {
  return typeof runToken === "number" && activeAgentRunToken !== runToken;
}

function hasComplexAgentMarker(text = "") {
  return /\band\b/i.test(text || "");
}

function isLatchedWakeExitPhrase(text = "") {
  const normalized = String(text || "").toLowerCase().trim().replace(/[.!?,]+$/g, "");
  if (!normalized) return false;
  return (
    normalized === "thanks" ||
    normalized === "thank you" ||
    normalized === "thanks cora" ||
    normalized === "thank you cora" ||
    normalized === "ok thanks" ||
    normalized === "okay thanks"
  );
}

function getVoiceStateTargetTabId(preferredTabId = null) {
  if (typeof preferredTabId === "number") return preferredTabId;
  if (typeof voiceState.targetTabId === "number") return voiceState.targetTabId;
  if (typeof voiceState.sessionTabId === "number") return voiceState.sessionTabId;
  if (typeof activeAgentTabId === "number") return activeAgentTabId;
  return null;
}

function getVoiceStateSnapshotForTab(tabId = null) {
  const targetTabId = getVoiceStateTargetTabId();
  if (typeof targetTabId !== "number" || typeof tabId !== "number" || tabId !== targetTabId) {
    return {
      sessionActive: false,
      processingActive: false,
      listeningActive: false,
      captureMode: null,
    };
  }

  return {
    sessionActive: !!voiceState.sessionActive,
    processingActive: !!voiceState.processingActive,
    listeningActive: !!voiceState.listeningActive,
    captureMode: voiceState.captureMode || null,
  };
}

function broadcastVoiceState(preferredTabId = null) {
  const targetTabId = getVoiceStateTargetTabId(preferredTabId);
  if (typeof targetTabId !== "number") return;
  fireAndForgetTabMessage(
    targetTabId,
    {
      type: "UI_VOICE_STATE",
      ...getVoiceStateSnapshotForTab(targetTabId),
    },
    0
  );
}

function updateVoiceState(patch = {}, preferredTabId = null) {
  Object.assign(voiceState, patch);
  if (typeof preferredTabId === "number") {
    voiceState.targetTabId = preferredTabId;
  }
  if (!voiceState.sessionActive) {
    voiceState.sessionTabId = null;
  }
  if (!voiceState.listeningActive) {
    voiceState.captureMode = null;
  }
  if (voiceState.sessionActive && typeof voiceState.sessionTabId === "number") {
    voiceState.targetTabId = voiceState.sessionTabId;
  }
  if (!voiceState.sessionActive && !voiceState.processingActive && !voiceState.listeningActive) {
    voiceState.targetTabId = null;
  }
  broadcastVoiceState(preferredTabId);
}

function beginSimpleListening(tabId) {
  updateVoiceState(
    {
      sessionActive: false,
      processingActive: false,
      listeningActive: true,
      captureMode: "simple",
      sessionTabId: null,
      targetTabId: typeof tabId === "number" ? tabId : voiceState.targetTabId,
    },
    tabId
  );
}

function pauseSimpleListening(tabId) {
  updateVoiceState(
    {
      sessionActive: false,
      processingActive: false,
      listeningActive: false,
      captureMode: null,
      sessionTabId: null,
      targetTabId: typeof tabId === "number" ? tabId : voiceState.targetTabId,
    },
    tabId
  );
}

function beginSessionListening(tabId) {
  updateVoiceState(
    {
      sessionActive: true,
      processingActive: false,
      listeningActive: true,
      captureMode: "session",
      sessionTabId: typeof tabId === "number" ? tabId : voiceState.sessionTabId,
      targetTabId: typeof tabId === "number" ? tabId : voiceState.targetTabId,
    },
    tabId
  );
}

function pauseSessionListening(tabId) {
  updateVoiceState(
    {
      sessionActive: true,
      processingActive: false,
      listeningActive: false,
      captureMode: null,
      sessionTabId: typeof tabId === "number" ? tabId : voiceState.sessionTabId,
      targetTabId: typeof tabId === "number" ? tabId : voiceState.targetTabId,
    },
    tabId
  );
}

function beginSessionProcessing(tabId) {
  updateVoiceState(
    {
      sessionActive: true,
      processingActive: true,
      listeningActive: false,
      captureMode: null,
      sessionTabId: typeof tabId === "number" ? tabId : voiceState.sessionTabId,
      targetTabId: typeof tabId === "number" ? tabId : voiceState.targetTabId,
    },
    tabId
  );
}

function beginOneOffProcessing(tabId) {
  updateVoiceState(
    {
      sessionActive: false,
      processingActive: true,
      listeningActive: false,
      captureMode: null,
      sessionTabId: null,
      targetTabId: typeof tabId === "number" ? tabId : voiceState.targetTabId,
    },
    tabId
  );
}

function beginInterruptListening(tabId) {
  updateVoiceState(
    {
      sessionActive: true,
      processingActive: false,
      listeningActive: true,
      captureMode: "interrupt",
      sessionTabId: typeof tabId === "number" ? tabId : voiceState.sessionTabId,
      targetTabId: typeof tabId === "number" ? tabId : voiceState.targetTabId,
    },
    tabId
  );
}

function endVoiceSession(tabId = null) {
  updateVoiceState(
    {
      sessionActive: false,
      processingActive: false,
      listeningActive: false,
      captureMode: null,
      sessionTabId: null,
      targetTabId: typeof tabId === "number" ? tabId : null,
    },
    tabId
  );
}

function hasLatchedWakeForTab(tabId) {
  return !!voiceState.sessionActive && typeof tabId === "number" && voiceState.sessionTabId === tabId;
}

function markLatchedWakeSession(tabId) {
  if (typeof tabId !== "number") return;
  updateVoiceState(
    {
      sessionActive: true,
      processingActive: false,
      listeningActive: false,
      captureMode: null,
      sessionTabId: tabId,
      targetTabId: tabId,
    },
    tabId
  );
}

async function settleLatchedWakeSession(tabId) {
  if (!hasLatchedWakeForTab(tabId)) return;
  beginSessionListening(tabId);
}

async function clearLatchedWakeSession(tabId = null) {
  const targetTabId = typeof tabId === "number" ? tabId : voiceState.sessionTabId;
  endVoiceSession(targetTabId);
}

function setPendingSummarySession(tabId, keepSession) {
  if (typeof tabId !== "number") return;
  if (keepSession) {
    pendingSummarySessionTabs.add(tabId);
  } else {
    pendingSummarySessionTabs.delete(tabId);
  }
}

function consumePendingSummarySession(tabId) {
  if (typeof tabId !== "number") return false;
  const keepSession = pendingSummarySessionTabs.has(tabId);
  pendingSummarySessionTabs.delete(tabId);
  return keepSession;
}

function finalizeSummaryVoiceState(tabId, keepSession = false) {
  if (typeof tabId !== "number") return;
  if (keepSession) {
    beginSessionListening(tabId);
  } else {
    endVoiceSession(tabId);
  }
  fireAndForgetTabMessage(tabId, { type: "UI_RESPONSE_DONE" }, 0);
}

function sanitizeDebugValue(value, key = "", depth = 0) {
  if (depth > 5) {
    return "[max_depth]";
  }
  if (typeof value === "string") {
    if (key === "screenshotDataUrl" || key === "screenshot_data_url") {
      return `[data_url length=${value.length}]`;
    }
    if (value.length > DEBUG_STRING_LIMIT) {
      return `${value.slice(0, DEBUG_STRING_LIMIT)}...[truncated ${value.length - DEBUG_STRING_LIMIT} chars]`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const next = value.slice(0, DEBUG_ARRAY_LIMIT).map((item) => sanitizeDebugValue(item, key, depth + 1));
    if (value.length > DEBUG_ARRAY_LIMIT) {
      next.push(`[${value.length - DEBUG_ARRAY_LIMIT} more items]`);
    }
    return next;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    out[childKey] = sanitizeDebugValue(childValue, childKey, depth + 1);
  }
  return out;
}

function debugLog(label, payload) {
  if (!DEBUG_CONTROLLER) return;
  if (payload === undefined) {
    console.log(`[debug] ${label}`);
    return;
  }
  const sanitized = sanitizeDebugValue(payload);
  console.log(`[debug] ${label}`, sanitized);
  const tabId = typeof sanitized?.tab_id === "number" ? sanitized.tab_id : activeAgentTabId;
  if (typeof tabId === "number") {
    mirrorDebugLogToPage(tabId, label, sanitized);
    fireAndForgetTabMessage(tabId, {
      type: MSG_TYPES.DEBUG_LOG,
      label,
      payload: sanitized,
      ts: new Date().toISOString(),
    }, 0);
  }
}

function mirrorDebugLogToPage(tabId, label, payload) {
  try {
    chrome.scripting.executeScript(
      {
        target: { tabId },
        world: "MAIN",
        args: [label, payload, new Date().toISOString()],
        func: (eventLabel, eventPayload, eventTimestamp) => {
          try {
            const entry = {
              label: eventLabel || "event",
              payload: eventPayload ?? null,
              ts: eventTimestamp,
            };

            const logs = Array.isArray(window.__CORA_DEBUG_LOGS) ? window.__CORA_DEBUG_LOGS : [];
            logs.push(entry);
            if (logs.length > 200) logs.splice(0, logs.length - 200);

            window.__CORA_DEBUG_LOGS = logs;
            window.__CORA_LAST_DEBUG_EVENT = entry;
            window.__CORA_DEBUG_STATE = window.__CORA_DEBUG_STATE || {};

            if (entry.payload && typeof entry.payload === "object") {
              if (entry.payload.task_state) {
                window.__CORA_LAST_TASK_STATE = entry.payload.task_state;
                window.__CORA_DEBUG_STATE.taskState = entry.payload.task_state;
                window.__CORA_DEBUG_STATE.subgoals = entry.payload.task_state.subgoal_queue || [];
              }

              if (entry.label === "worker.call.input") {
                window.__CORA_LAST_WORKER_INPUT = entry.payload.worker_input || entry.payload;
                window.__CORA_DEBUG_STATE.workerInput = window.__CORA_LAST_WORKER_INPUT;
              }

              if (entry.label === "worker.call.output") {
                window.__CORA_LAST_WORKER_OUTPUT = entry.payload.worker_output || entry.payload;
                window.__CORA_DEBUG_STATE.workerOutput = window.__CORA_LAST_WORKER_OUTPUT;
              }

              if (entry.label === "orchestrator.init.output") {
                window.__CORA_INITIAL_TASK_STATE = entry.payload.task_state || null;
              }

              if (entry.label === "task.mutation.result") {
                window.__CORA_LAST_MUTATION = entry.payload;
              }
            }

            console.log(`[cora-debug] ${entry.label}`, entry.payload ?? null);
          } catch (_) {}
        },
      },
      () => {
        void chrome.runtime.lastError;
      }
    );
  } catch (_) {}
}

function debugTaskStateSnapshot(taskState) {
  if (!taskState) return null;
  return {
    task_id: taskState.task_id,
    goal: taskState.goal,
    state_revision: taskState.state_revision,
    task_status: taskState.task_status,
    active_subgoal_id: taskState.active_subgoal_id,
    subgoal_queue: taskState.subgoal_queue,
    memory: taskState.memory,
    last_step: taskState.last_step,
    history: taskState.history,
    pending_question: taskState.pending_question,
    error: taskState.error,
    change_log: taskState.change_log,
  };
}

function getOrCreateSession(tabId) {
  if (sessionState.has(tabId)) {
    return sessionState.get(tabId);
  }
  const session = {
    lastSummary: "",
    lastPageContext: "",
    lastUserReply: "",
    lastAction: null,
    lastStepNote: "",
    taskState: null,
    controllerRunId: 0,
    consecutiveFailures: 0,
    actionHistory: [],
    askCache: {},
  };
  sessionState.set(tabId, session);
  return session;
}

function getCurrentTaskState(tabId) {
  return getOrCreateSession(tabId).taskState || null;
}

function setCurrentTaskState(tabId, taskState) {
  const session = getOrCreateSession(tabId);
  session.taskState = taskState || null;
  return session.taskState;
}

function moveSessionState(fromTabId, toTabId) {
  if (fromTabId === toTabId) {
    return getOrCreateSession(fromTabId);
  }
  const session = getOrCreateSession(fromTabId);
  sessionState.delete(fromTabId);
  sessionState.set(toTabId, session);
  if (activeAgentTabId === fromTabId) {
    activeAgentTabId = toTabId;
  }
  if (voiceState.sessionTabId === fromTabId) {
    voiceState.sessionTabId = toTabId;
  }
  if (voiceState.targetTabId === fromTabId) {
    voiceState.targetTabId = toTabId;
  }
  return session;
}

function isTaskStateMode(mode) {
  return mode !== "baseline" && mode !== "planner_executor";
}

function isTerminalTaskStatus(status) {
  return status === "completed" || status === "failed";
}

function getCurrentSubgoal(taskState) {
  if (!taskState || !Array.isArray(taskState.subgoal_queue)) return null;
  return taskState.subgoal_queue.find((subgoal) => subgoal.id === taskState.active_subgoal_id) || null;
}

function appendHistory(taskState, summary) {
  if (!taskState || typeof summary !== "string") return;
  const trimmed = summary.trim();
  if (!trimmed) return;
  const nextHistory = Array.isArray(taskState.history) ? taskState.history.slice() : [];
  nextHistory.push(trimmed);
  taskState.history = nextHistory.slice(-MAX_HISTORY_ENTRIES);
}

function isFailureHeavyText(text = "") {
  if (typeof text !== "string") return false;
  return /\b(fail|failed|failure|retry|retrying|error|invalid|could not|not typeable|unexpected)\b/i.test(text);
}

function formatActionLabel(action) {
  if (!action || typeof action.type !== "string") return "step";
  if (action.type === "scroll") return `scroll ${String(action.value || "").trim()}`.trim();
  if (action.type === "select_type") return "select and type";
  if (action.type === "type_text") return "type text";
  if (action.type === "click_index") return "click target";
  return action.type.replace(/_/g, " ");
}

function replaceLastHistoryEntry(taskState, summary) {
  if (!taskState || !Array.isArray(taskState.history) || !taskState.history.length) return;
  taskState.history[taskState.history.length - 1] = summary;
}

function cleanupRecoveryContext(taskState, workerOutput, executedInfo = "") {
  if (!taskState || !workerOutput) return false;
  const wasCorrectiveStep = workerOutput.verification !== "passed" || workerOutput.corrective_action !== null;
  if (!wasCorrectiveStep) return false;

  // A successful corrective action should clear stale failure state so the next worker turn
  // sees the current success, not an outdated retry/error narrative.
  taskState.error = null;

  const action = taskState.last_step?.action || workerOutput.action || null;
  const currentSummary = taskState.last_step?.summary || workerOutput.summary || "";
  const normalizedSummary = isFailureHeavyText(currentSummary)
    ? `Corrective action succeeded: ${executedInfo || formatActionLabel(action)}.`
    : currentSummary;

  if (taskState.last_step) {
    taskState.last_step.summary = normalizedSummary;
    if (taskState.last_step.result && taskState.last_step.result.status === "executed") {
      taskState.last_step.result.detail = executedInfo || normalizedSummary;
    }
  }

  const filteredHistory = (Array.isArray(taskState.history) ? taskState.history : [])
    .filter((entry) => !isFailureHeavyText(entry));
  filteredHistory.push(normalizedSummary);
  taskState.history = filteredHistory.slice(-MAX_HISTORY_ENTRIES);
  replaceLastHistoryEntry(taskState, normalizedSummary);

  const scratchpadLines = String(taskState.memory?.scratchpad || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isFailureHeavyText(line));
  scratchpadLines.push(`Recovered: ${executedInfo || formatActionLabel(action)} worked.`);
  if (!taskState.memory || typeof taskState.memory !== "object") {
    taskState.memory = { scratchpad: "", entities: [] };
  }
  taskState.memory.scratchpad = trimScratchpad(scratchpadLines.slice(-4).join("\n"));
  return true;
}

function trimScratchpad(text = "") {
  const scratchpad = typeof text === "string" ? text : "";
  if (scratchpad.length <= MAX_SCRATCHPAD_LENGTH) return scratchpad;
  return scratchpad.slice(-MAX_SCRATCHPAD_LENGTH);
}

function nextEntityId(memory) {
  const entities = Array.isArray(memory?.entities) ? memory.entities : [];
  let maxId = 0;
  for (const entity of entities) {
    const match = typeof entity?.entity_id === "string" ? entity.entity_id.match(/^e_(\d+)$/) : null;
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > maxId) {
      maxId = value;
    }
  }
  return `e_${maxId + 1}`;
}

function applyMemoryPatch(taskState, memoryPatch) {
  if (!taskState) return taskState;
  const validatedPatch = self.validateMemoryPatch(memoryPatch || {
    scratchpad_set: null,
    scratchpad_append: null,
    entity_add: [],
    entity_update: [],
    entity_remove: [],
  });
  debugLog("memory_patch.apply", {
    task_id: taskState.task_id,
    state_revision: taskState.state_revision,
    patch: validatedPatch,
  });

  if (!taskState.memory || typeof taskState.memory !== "object") {
    taskState.memory = { scratchpad: "", entities: [] };
  }
  if (!Array.isArray(taskState.memory.entities)) {
    taskState.memory.entities = [];
  }
  if (typeof taskState.memory.scratchpad !== "string") {
    taskState.memory.scratchpad = "";
  }

  if (validatedPatch.scratchpad_set !== null) {
    taskState.memory.scratchpad = validatedPatch.scratchpad_set;
  }
  if (validatedPatch.scratchpad_append) {
    const prefix = taskState.memory.scratchpad ? `${taskState.memory.scratchpad}\n` : "";
    taskState.memory.scratchpad = `${prefix}${validatedPatch.scratchpad_append}`;
  }

  for (const entity of validatedPatch.entity_add) {
    taskState.memory.entities.push({
      entity_id: nextEntityId(taskState.memory),
      type: entity.type,
      data: entity.data,
    });
  }

  for (const update of validatedPatch.entity_update) {
    const target = taskState.memory.entities.find((entity) => entity.entity_id === update.entity_id);
    if (!target) continue;
    const currentData = target.data && typeof target.data === "object" ? target.data : {};
    target.data = { ...currentData, ...update.data_patch };
  }

  if (validatedPatch.entity_remove.length) {
    const removedIds = new Set(validatedPatch.entity_remove);
    taskState.memory.entities = taskState.memory.entities.filter((entity) => !removedIds.has(entity.entity_id));
  }

  taskState.memory.scratchpad = trimScratchpad(taskState.memory.scratchpad);
  debugLog("memory_patch.result", {
    task_id: taskState.task_id,
    memory: taskState.memory,
  });
  return taskState;
}

function discardStaleWorkerOutput(taskState, workerOutput) {
  return !taskState || !workerOutput || workerOutput.state_revision !== taskState.state_revision;
}

function validateWorkerOutput(workerOutput, expectedRevision = null) {
  return self.validateWorkerOutput(workerOutput, expectedRevision);
}

function validateOrchestratorOutput(payload, operation) {
  if (operation === "initialize") {
    return self.validateTaskState(payload);
  }
  return self.validateOrchestratorMutation(payload);
}

function buildPageContext(observation) {
  return {
    url: observation?.url || "",
    title: observation?.title || "",
    context_text: observation?.pageContext || "",
    elements: Array.isArray(observation?.elements) ? observation.elements : [],
    focused_element: observation?.focusedElement || null,
    selection_text: observation?.selectionText || "",
  };
}

function buildBrowserContext(observation) {
  if (!observation) return {};
  return {
    url: observation.url || "",
    title: observation.title || "",
    page_context: buildPageContext(observation),
  };
}

function buildWorkerInput(taskState, observation) {
  const currentSubgoal = getCurrentSubgoal(taskState);
  return {
    task_id: taskState.task_id,
    goal: taskState.goal,
    state_revision: taskState.state_revision,
    current_subgoal: currentSubgoal
      ? { id: currentSubgoal.id, objective: currentSubgoal.objective }
      : { id: "", objective: "" },
    memory: {
      scratchpad: taskState.memory?.scratchpad || "",
      entities: Array.isArray(taskState.memory?.entities) ? taskState.memory.entities : [],
    },
    last_step: {
      summary: taskState.last_step?.summary || "",
      action: taskState.last_step?.action || null,
      result: taskState.last_step?.result || null,
    },
    history: Array.isArray(taskState.history) ? taskState.history.slice(-MAX_HISTORY_ENTRIES) : [],
    page_context: buildPageContext(observation),
    error: taskState.error || null,
    screenshot_data_url: observation?.screenshotDataUrl || "",
  };
}

function buildOrchestratorInitInput(goalText, observation = null) {
  return {
    orchestratorPrompt: self.ORCHESTRATOR_PROMPT || "",
    operation: "initialize",
    goal: goalText || "",
    browserContext: buildBrowserContext(observation),
  };
}

function buildOrchestratorInterruptInput(taskState, userText, observation = null) {
  return {
    orchestratorPrompt: self.ORCHESTRATOR_PROMPT || "",
    operation: "mutate",
    taskState,
    userText: userText || "",
    browserContext: buildBrowserContext(observation),
  };
}

function updateTaskLastStep(taskState, action, summary, result) {
  if (!taskState) return;
  taskState.last_step = {
    action: action || null,
    summary: typeof summary === "string" ? summary.trim() : "",
    timestamp: new Date().toISOString(),
    result: result || null,
  };
}

function nextPendingSubgoal(taskState) {
  if (!taskState || !Array.isArray(taskState.subgoal_queue)) return null;
  return taskState.subgoal_queue.find((subgoal) => subgoal.status === "pending") || null;
}

function advanceSubgoal(taskState) {
  if (!taskState) return null;
  const current = getCurrentSubgoal(taskState);
  if (current && current.status === "pending") {
    current.status = "completed";
  }

  // active_subgoal_id is the only active-subgoal source of truth. Status stays lifecycle-only.
  const next = nextPendingSubgoal(taskState);
  if (next) {
    taskState.active_subgoal_id = next.id;
    taskState.state_revision += 1;
    return next;
  }

  taskState.task_status = "completed";
  return null;
}

function pickActiveSubgoalId(subgoalQueue, fallbackId = "") {
  if (!Array.isArray(subgoalQueue)) return fallbackId;
  const pending = subgoalQueue.find((subgoal) => subgoal.status === "pending");
  if (pending) return pending.id;
  const exact = subgoalQueue.find((subgoal) => subgoal.id === fallbackId);
  return exact ? exact.id : fallbackId;
}

function applyInterruptMutation(taskState, mutationResult, userText) {
  if (!taskState) {
    throw new Error("No task state available for mutation");
  }
  const validated = validateOrchestratorOutput(mutationResult, "mutate");
  debugLog("task.mutation.request", {
    user_text: userText,
    before: debugTaskStateSnapshot(taskState),
    mutation: validated,
  });
  const completedSubgoals = Array.isArray(taskState.subgoal_queue)
    ? taskState.subgoal_queue.filter((subgoal) => subgoal.status === "completed")
    : [];
  const completedById = new Map(completedSubgoals.map((subgoal) => [subgoal.id, subgoal]));

  for (const subgoal of validated.subgoal_queue) {
    if (completedById.has(subgoal.id) && subgoal.status !== "completed") {
      throw new Error("Interrupt mutation cannot downgrade completed subgoals");
    }
  }

  const mergedQueue = [];
  for (const subgoal of taskState.subgoal_queue || []) {
    if (subgoal.status === "completed") {
      mergedQueue.push(subgoal);
    }
  }
  for (const subgoal of validated.subgoal_queue) {
    if (completedById.has(subgoal.id)) continue;
    mergedQueue.push(subgoal);
  }

  taskState.goal = validated.goal;
  taskState.subgoal_queue = mergedQueue;
  taskState.active_subgoal_id = pickActiveSubgoalId(mergedQueue, validated.active_subgoal_id || taskState.active_subgoal_id);
  taskState.pending_question = validated.pending_question || null;
  taskState.error = validated.error || null;
  // User interrupts change the meaning of the task, so the controller bumps state_revision here.
  taskState.state_revision += 1;
  taskState.change_log.push({
    revision: taskState.state_revision,
    user_text: userText || "",
    target_subgoal_id: taskState.active_subgoal_id,
  });
  if (taskState.pending_question) {
    taskState.task_status = "waiting_user";
  } else if (nextPendingSubgoal(taskState)) {
    taskState.task_status = "running";
  } else {
    taskState.task_status = "completed";
  }
  debugLog("task.mutation.result", debugTaskStateSnapshot(taskState));
  return taskState;
}

function resetControllerFailureState(session) {
  if (!session) return;
  session.consecutiveFailures = 0;
}

function incrementControllerFailure(session) {
  if (!session) return 0;
  session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;
  return session.consecutiveFailures;
}

function currentControllerRunId(session) {
  if (!session) return 0;
  session.controllerRunId = (session.controllerRunId || 0) + 1;
  return session.controllerRunId;
}

function getPendingQuestionText(questionPayload) {
  return questionPayload?.question || "";
}

function notifyAgentUi(tabId, isActive, frameId = 0) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(
        tabId,
        { type: isActive ? "UI_AGENT_START" : "UI_AGENT_STOP" },
        { frameId },
        () => {
          // Read lastError to suppress unchecked runtime.lastError noise.
          const _ignored = chrome.runtime.lastError;
          resolve(true);
        }
      );
    } catch (_) {
      resolve(false);
    }
  });
}

function fireAndForgetTabMessage(tabId, payload, frameId = 0) {
  try {
    chrome.tabs.sendMessage(tabId, payload, { frameId }, () => {
      // Fire-and-forget UI messages do not require a reply. Reading lastError here prevents
      // "The message port closed before a response was received" noise in DevTools.
      const _ignored = chrome.runtime.lastError;
    });
  } catch (_) {}
}

function logTiming(label, startMs, thresholdMs = 0) {
  const elapsed = Date.now() - startMs;
  if (elapsed >= thresholdMs) {
    console.log(`[timing] ${label}: ${elapsed}ms`);
  }
}

async function triggerShowShortcut(tabId) {
  try {
    let targetTabId = null;
    const tabs = await chrome.tabs.query({});
    let highestId = null;
    for (const t of tabs) {
      if (t && typeof t.id === "number") {
        if (highestId === null || t.id > highestId) {
          highestId = t.id;
        }
      }
    }
    // Always target the highest tab id, regardless of the provided tabId.
    targetTabId = highestId;
    console.log("[agent] triggerShowShortcut: highest tab id:", highestId, "targeting tab id:", targetTabId);
    if (targetTabId === null) {
      console.warn("[agent] triggerShowShortcut: no tabs found");
      return null;
    }

    console.log("[agent] triggerShowShortcut: targeting tab id:", targetTabId);

    await chrome.tabs.update(targetTabId, { active: true });
    const frameId = await getBestFrameId(targetTabId);
    console.log("[agent] triggerShowShortcut: targeting frame", frameId);
    console.log("[agent] triggerShowShortcut chose frame id:", frameId);
    const showResult = await sendMessageToTab(targetTabId, { type: MSG_TYPES.OBSERVE_SHOW }, frameId);
    await sleep(50);
    const hideResult = await sendMessageToTab(targetTabId, { type: MSG_TYPES.OBSERVE_HIDE }, frameId);
    const screenshotDataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
        const err = chrome.runtime.lastError;
        if (err || !dataUrl) {
          reject(err || new Error("captureVisibleTab failed"));
          return;
        }
        resolve(dataUrl);
      });
    });
    console.log("[agent] triggerShowShortcut: tab", targetTabId, "frame", frameId, "captured screenshot length", screenshotDataUrl?.length || 0);
    return {
      frameId,
      screenshotDataUrl,
      showResult,
      hideResult,
    };
  } catch (err) {
    console.warn("[agent] triggerShowShortcut failed:", err?.message || err);
    return null;
  }
}

async function getCommandTargetTab(sourceTabId = null) {
  if (typeof sourceTabId === "number") {
    const sourceTab = await getTabById(sourceTabId);
    if (sourceTab) return sourceTab;
  }
  return getActiveTab();
}

async function resolveSimpleCommand(commandText) {
  if (!commandText) return null;

  if (manualOverlayMode) {
    const manualOverlayIndex = parseManualOverlayIndex(commandText);
    if (manualOverlayIndex !== null) {
      return {
        command: { kind: "click_index", value: manualOverlayIndex, source: "overlay_numeric" },
        reason: "manual_overlay_numeric",
      };
    }
    await disableManualOverlayMode();
  }

  const localSimple = detectSimpleCommand(commandText);
  if (localSimple) {
    return {
      command: localSimple,
      reason: "local_detection",
    };
  }

  if (!shouldBypassSimpleIntent(commandText)) {
    const llmSimple = await classifyIntent(commandText);
    if (llmSimple) {
      return {
        command: llmSimple,
        reason: "intent_classifier",
      };
    }
  }

  return null;
}

async function rearmSimpleListening(targetTabId, { navigationSensitive = false } = {}) {
  if (typeof targetTabId !== "number") return;

  if (navigationSensitive) {
    await waitForTabComplete(targetTabId, 5000).catch(() => {});
    await ensureContentScriptInjected(targetTabId).catch(() => {});
  }

  beginSimpleListening(targetTabId);

  if (!navigationSensitive) return;

  for (const delayMs of [150, 400, 800]) {
    await sleep(delayMs);
    const tab = await getTabById(targetTabId).catch(() => null);
    if (!tab || isDisallowedUrl(tab.url || "")) {
      return;
    }
    if (tab.status && tab.status !== "complete") {
      continue;
    }
    await ensureContentScriptInjected(targetTabId).catch(() => {});
    beginSimpleListening(targetTabId);
  }
}

async function executeSimpleCommandWithRearm(simpleResolution, targetTabId, { endSessionWhenNoTab = false } = {}) {
  if (!simpleResolution?.command) return null;

  if (targetTabId !== null) {
    pauseSimpleListening(targetTabId);
  } else if (endSessionWhenNoTab) {
    endVoiceSession();
  }

  const simpleResult = await runSimpleCommand(simpleResolution.command, targetTabId);
  const nextTabId =
    typeof simpleResult?.tabId === "number"
      ? simpleResult.tabId
      : targetTabId;

  if (nextTabId !== null) {
    const navigationSensitive =
      simpleResolution.command?.kind === "click_index" ||
      nextTabId !== targetTabId;
    await rearmSimpleListening(nextTabId, { navigationSensitive });
  }

  return simpleResult;
}

async function runSimpleLoopCommand(commandText, targetTab, { fromSession = false } = {}) {
  const targetTabId = typeof targetTab?.id === "number" ? targetTab.id : null;
  const simpleResolution = await resolveSimpleCommand(commandText);
  if (!simpleResolution) {
    if (targetTabId !== null) {
      await rearmSimpleListening(targetTabId);
    }
    debugLog("router.decision", {
      route: "ignored",
      reason: fromSession ? "session_simple_fallback_ignored" : "simple_loop_non_simple_ignored",
      command_text: commandText,
    });
    return false;
  }

  debugLog("router.decision", {
    route: "simple_command",
    reason: simpleResolution.reason,
    command_text: commandText,
    simple_command: simpleResolution.command,
    source_mode: fromSession ? "session" : "simple",
  });

  await executeSimpleCommandWithRearm(simpleResolution, targetTabId);
  return true;
}

async function runSessionSimpleFallback(commandText, targetTab) {
  const targetTabId = typeof targetTab?.id === "number" ? targetTab.id : null;
  const simpleResolution = await resolveSimpleCommand(commandText);
  if (!simpleResolution) return false;

  debugLog("router.decision", {
    route: "simple_command",
    reason: simpleResolution.reason,
    command_text: commandText,
    simple_command: simpleResolution.command,
    source_mode: "session",
  });

  await executeSimpleCommandWithRearm(simpleResolution, targetTabId, { endSessionWhenNoTab: true });
  return true;
}

async function routeSessionCommand(commandText, targetTab, { source = "session", allowSimpleFallback = true } = {}) {
  const targetTabId = typeof targetTab?.id === "number" ? targetTab.id : null;
  if (targetTabId !== null && manualOverlayMode) {
    await disableManualOverlayMode();
  }

  if (isLatchedWakeExitPhrase(commandText)) {
    debugLog("router.decision", {
      route: "latched_session_stop",
      reason: "thanks_exit",
      command_text: commandText,
      source_mode: source,
    });
    await clearLatchedWakeSession(targetTabId);
    return;
  }

  if (allowSimpleFallback && await runSessionSimpleFallback(commandText, targetTab)) {
    return;
  }

  if (targetTabId !== null) {
    beginSessionProcessing(targetTabId);
  }

  const summarizeReason = summarizeTriggerMatch(commandText);
  if (summarizeReason) {
    debugLog("router.decision", {
      route: "summarize",
      reason: summarizeReason,
      command_text: commandText,
      source_mode: source,
    });
    await summarizeScreenshot(commandText, targetTabId, { keepSession: true });
    return;
  }

  const targetMode = hasComplexAgentMarker(commandText) ? "task_state" : "baseline";
  debugLog("router.decision", {
    route: targetMode === "task_state" ? "agent_complex" : "agent_simple",
    reason: targetMode === "task_state" ? "session_contains_and" : "session_default_baseline",
    command_text: commandText,
    active_agent_mode: activeAgentMode,
    source_mode: source,
  });

  if (isAgentRunning && activeAgentTabId !== null) {
    await interruptActiveTask(commandText, targetMode);
    return;
  }

  startAgent(
    commandText,
    targetTab && typeof targetTab.id === "number" && targetTab.windowId !== undefined
      ? { tabId: targetTab.id, windowId: targetTab.windowId }
      : undefined,
    targetMode
  ).catch((e) => console.error("[agent] crashed:", e));
}

async function handleTextCommand(rawText, { sourceTabId = null, captureMode = null } = {}) {
  const text = (rawText || "").trim();
  if (!text) return;

  const targetTab = await getCommandTargetTab(sourceTabId);
  const targetTabId = typeof targetTab?.id === "number" ? targetTab.id : null;
  const lowered = text.toLowerCase();
  const hotwords = ["hey cora", "hey quora", "hey clara"];
  const matchedHotword = hotwords.find((hw) => lowered.startsWith(hw));
  const stripped = matchedHotword ? stripLeadingCommandPunctuation(text.slice(matchedHotword.length)) : "";
  const commandText = matchedHotword ? (stripped || "") : text;

  if (captureMode === "interrupt") {
    const targetMode = hasComplexAgentMarker(text) ? "task_state" : "baseline";
    const interruptTabId = getVoiceStateTargetTabId(targetTabId);
    if (typeof interruptTabId === "number") {
      beginSessionProcessing(interruptTabId);
    }
    debugLog("router.decision", {
      route: "agent_interrupt",
      reason: "explicit_interrupt_capture",
      command_text: text,
      active_agent_mode: activeAgentMode,
    });
    await interruptActiveTask(text, targetMode);
    return;
  }

  if (captureMode === "simple") {
    if (matchedHotword) {
      if (targetTabId !== null) {
        markLatchedWakeSession(targetTabId);
      }
      if (!stripped) {
        if (targetTabId !== null) {
          beginSessionListening(targetTabId);
        }
        return;
      }
      await routeSessionCommand(stripped, targetTab, {
        source: "simple_hotword",
        allowSimpleFallback: false,
      });
      return;
    }

    await runSimpleLoopCommand(text, targetTab);
    return;
  }

  if (captureMode === "session") {
    const sessionCommand = matchedHotword ? (stripped || "") : text;
    if (!sessionCommand) {
      if (targetTabId !== null) {
        beginSessionListening(targetTabId);
      }
      return;
    }
    await routeSessionCommand(sessionCommand, targetTab, {
      source: "session",
      allowSimpleFallback: !matchedHotword,
    });
    return;
  }

  const activeSessionForSource =
    typeof targetTabId === "number" &&
    voiceState.sessionActive &&
    voiceState.sessionTabId === targetTabId;
  const shouldKeepSession =
    !!matchedHotword ||
    captureMode === "session" ||
    captureMode === "interrupt" ||
    activeSessionForSource ||
    (
      voiceState.sessionActive &&
      typeof voiceState.sessionTabId === "number" &&
      (
        (typeof sourceTabId === "number" && sourceTabId === voiceState.sessionTabId) ||
        (typeof targetTabId === "number" && targetTabId === voiceState.sessionTabId)
      )
    );

  if (matchedHotword) {
    if (targetTabId !== null) {
      markLatchedWakeSession(targetTabId);
    }
    if (!stripped) {
      if (targetTabId !== null) {
        beginSessionListening(targetTabId);
      }
      return;
    }
    await routeSessionCommand(stripped, targetTab, {
      source: "manual_hotword",
      allowSimpleFallback: false,
    });
    return;
  }

  if (activeSessionForSource) {
    await routeSessionCommand(text, targetTab, { source: "manual_session" });
    return;
  }

  const simpleResolution = await resolveSimpleCommand(text);
  if (simpleResolution) {
    debugLog("router.decision", {
      route: "simple_command",
      reason: simpleResolution.reason,
      command_text: text,
      simple_command: simpleResolution.command,
      source_mode: "manual",
    });
    await executeSimpleCommandWithRearm(simpleResolution, targetTabId);
    return;
  }

  const summarizeReason = summarizeTriggerMatch(text);
  if (summarizeReason) {
    if (targetTabId !== null) {
      if (shouldKeepSession) {
        beginSessionProcessing(targetTabId);
      } else {
        beginOneOffProcessing(targetTabId);
      }
    }
    await summarizeScreenshot(text, targetTabId, { keepSession: shouldKeepSession });
    return;
  }

  const targetMode = hasComplexAgentMarker(text) ? "task_state" : "baseline";
  if (targetTabId !== null) {
    beginOneOffProcessing(targetTabId);
  }
  debugLog("router.decision", {
    route: targetMode === "task_state" ? "agent_complex" : "agent_simple",
    reason: targetMode === "task_state" ? "manual_contains_and" : "manual_default_baseline",
    command_text: text,
    active_agent_mode: activeAgentMode,
    source_mode: "manual",
  });

  if (isAgentRunning && activeAgentTabId !== null) {
    await interruptActiveTask(text, targetMode);
    return;
  }

  startAgent(
    text,
    targetTab && typeof targetTab.id === "number" && targetTab.windowId !== undefined
      ? { tabId: targetTab.id, windowId: targetTab.windowId }
      : undefined,
    targetMode
  ).catch((e) => console.error("[agent] crashed:", e));
}

function summarizeTriggerMatch(text) {
  const t = (text || "").toLowerCase();
  if (!t) return null;
  if (/^summarize\b/.test(t)) return "summarize";
  if (/^explain\b/.test(t)) return "explain";
  if (/^how\b/.test(t)) return "how";
  if (/^what['’]s\b/.test(t)) return "what's";
  if (/^what\b/.test(t)) return "what";
  return null;
}

function stripLeadingCommandPunctuation(text = "") {
  return String(text || "").replace(/^[\s,.:;!?-]+/, "").trim();
}

function shouldBypassSimpleIntent(text) {
  const t = (text || "").toLowerCase().trim();
  if (!t) return false;

  const multiStepMarkers = [
    " and then ",
    " then ",
    " after that ",
    " after ",
    " before ",
    " latest ",
    " first ",
    " next ",
  ];
  const actionPatterns = [
    /\bgo to\b/,
    /\bopen\b/,
    /\bclick\b/,
    /\bselect\b/,
    /\btype\b/,
    /\bfill\b/,
    /\bsearch\b/,
    /\bfind\b/,
    /\bsubscribe\b/,
    /\bplay\b/,
    /\bpause\b/,
    /\bsend\b/,
    /\bcreate\b/,
    /\bdraft\b/,
    /\blog in\b/,
    /\bsign in\b/,
  ];

  let hits = 0;
  for (const pattern of actionPatterns) {
    if (pattern.test(t)) hits += 1;
    if (hits >= 2) return true;
  }

  return multiStepMarkers.some((marker) => t.includes(marker)) && hits >= 1;
}

function classifyWorkerFailureSummary(errorMessage = "") {
  const text = typeof errorMessage === "string" ? errorMessage : "";
  if (!text) return "Worker call failed.";
  if (text.includes("LLM HTTP error") || text.includes("LLM request failed")) {
    return "Worker call failed.";
  }
  if (text.includes("Failed to parse LLM JSON response")) {
    return "Worker returned invalid JSON.";
  }
  if (text.includes("worker output")) {
    return "Worker output was invalid.";
  }
  return "Worker call failed.";
}

function isSummarizeRequest(text) {
  return summarizeTriggerMatch(text) !== null;
}

function isManualOverlayActiveForTab(tabId) {
  return manualOverlayMode && typeof tabId === "number" && manualOverlayTabId === tabId;
}

function parseSpokenInteger(text) {
  const raw = (text || "").toLowerCase().replace(/-/g, " ").replace(/\band\b/g, " ").trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);

  let total = 0;
  let current = 0;
  let seen = false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    if (Object.prototype.hasOwnProperty.call(SPOKEN_NUMBER_UNITS, token)) {
      current += SPOKEN_NUMBER_UNITS[token];
      seen = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SPOKEN_NUMBER_TENS, token)) {
      current += SPOKEN_NUMBER_TENS[token];
      seen = true;
      continue;
    }
    if (token === "hundred") {
      current = (current || 1) * 100;
      seen = true;
      continue;
    }
    if (token === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      seen = true;
      continue;
    }
    return null;
  }

  if (!seen) return null;
  return total + current;
}

function parseManualOverlayIndex(text) {
  if (!manualOverlayMode) return null;
  const normalized = normalizeSimpleCommandText(text).replace(/^number\s+/, "");
  const value = parseSpokenInteger(normalized);
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function normalizeSimpleCommandText(text) {
  return (text || "")
    .toLowerCase()
    .trim()
    .replace(/^[\s,.:;!?-]+/, "")
    .replace(/[\s,.:;!?-]+$/, "")
    .trim();
}

function detectSimpleCommand(text) {
  const t = normalizeSimpleCommandText(text);
  if (!t) return null;

  if (t === "show") return { kind: "show_overlays" };
  if (t === "hide") return { kind: "hide_overlays" };

  const manualOverlayIndex = parseManualOverlayIndex(t);
  if (manualOverlayIndex !== null) {
    return { kind: "click_index", value: manualOverlayIndex, source: "overlay_numeric" };
  }

  if (t.includes("scroll")) {
    if (t.includes("top")) return { kind: "scroll", value: "top" };
    if (t.includes("bottom") || t.includes("end")) return { kind: "scroll", value: "bottom" };
    if (t.includes("up")) return { kind: "scroll", value: "up" };
    if (t.includes("down")) return { kind: "scroll", value: "down" };
  }

  if (t === "next tab") return { kind: "tab", value: "next" };
  if (t === "previous tab" || t === "prev tab") return { kind: "tab", value: "prev" };

  const clickNum = t.match(/^(?:click|choose|select|press)\s+(\d+)$/);
  if (clickNum) return { kind: "click_index", value: Number(clickNum[1]) };

  const tabNum = t.match(/^tab\s+(\d+)$/);
  if (tabNum) return { kind: "switch_tab", value: Number(tabNum[1]) };

  const searchMatch = t.match(/^(?:search|google)\s+(.+)/);
  if (searchMatch) return { kind: "search", value: searchMatch[1].trim() };

  const openMatch = t.match(/^(?:open)\s+(.+)/);
  if (openMatch) return { kind: "open_url", value: openMatch[1].trim() };

  return null;
}

async function disableManualOverlayMode({ hide = true } = {}) {
  const previousTabId = manualOverlayTabId;
  manualOverlayMode = false;
  manualOverlayTabId = null;
  manualOverlayRefreshToken += 1;
  manualOverlayFollowUntil = 0;

  if (!hide || typeof previousTabId !== "number") return;
  try {
    fireAndForgetTabMessage(previousTabId, { type: MSG_TYPES.OBSERVE_HIDE }, 0);
  } catch (_) {}
}

async function refreshManualOverlayMode(tabId, { delayMs = 0 } = {}) {
  const refreshToken = manualOverlayRefreshToken;
  if (!isManualOverlayActiveForTab(tabId)) return false;
  if (delayMs > 0) await sleep(delayMs);
  if (refreshToken !== manualOverlayRefreshToken || !isManualOverlayActiveForTab(tabId)) return false;

  const tab = await getTabById(tabId);
  if (!tab || isDisallowedUrl(tab.url)) {
    await disableManualOverlayMode({ hide: false });
    return false;
  }

  if (tab.status && tab.status !== "complete") {
    return false;
  }

  await ensureContentScriptInjected(tabId).catch(() => {});
  if (refreshToken !== manualOverlayRefreshToken || !isManualOverlayActiveForTab(tabId)) return false;

  try {
    const result = await sendMessageToTab(tabId, { type: MSG_TYPES.OBSERVE_SHOW }, 0);
    return !!(result && result.success !== false);
  } catch (err) {
    console.warn("[overlay] Failed to refresh manual overlays:", err?.message || err);
    return false;
  }
}

function scheduleManualOverlayRefreshCycle(tabId, delays = MANUAL_OVERLAY_REFRESH_SCHEDULE_MS) {
  const refreshToken = manualOverlayRefreshToken;
  const attempts = Array.isArray(delays) && delays.length ? delays : [0];

  (async () => {
    for (const delayMs of attempts) {
      if (refreshToken !== manualOverlayRefreshToken || !isManualOverlayActiveForTab(tabId)) {
        return;
      }
      const refreshed = await refreshManualOverlayMode(tabId, { delayMs });
      if (refreshed) {
        return;
      }
    }
  })().catch((err) => {
    console.warn("[overlay] Refresh cycle failed:", err?.message || err);
  });
}

async function enableManualOverlayMode(tabId) {
  if (typeof tabId !== "number") return;
  const previousTabId = manualOverlayTabId;
  manualOverlayMode = true;
  manualOverlayTabId = tabId;
  manualOverlayRefreshToken += 1;
  if (typeof previousTabId === "number" && previousTabId !== tabId) {
    fireAndForgetTabMessage(previousTabId, { type: MSG_TYPES.OBSERVE_HIDE }, 0);
  }
  scheduleManualOverlayRefreshCycle(tabId, [0, ...MANUAL_OVERLAY_REFRESH_SCHEDULE_MS]);
}

async function runSimpleContentAction(tabId, action, value) {
  try {
    await ensureContentScriptInjected(tabId).catch(() => {});
    const result = await sendMessageToTab(tabId, { type: "EXEC_ACTION", action, value }, 0);
    if (!result || result.success === false) {
      console.warn("[router] Simple command failed:", result && result.error ? result.error : action);
      return { ok: false, error: (result && result.error) || "simple_command_failed" };
    }
    return { ok: true, result };
  } catch (err) {
    console.warn("[router] Simple command failed:", err?.message || err);
    return { ok: false, error: err?.message || "simple_command_failed" };
  }
}

async function getLastFocusedActiveTab() {
  const tabs = await queryTabs({ active: true, lastFocusedWindow: true });
  return Array.isArray(tabs) && tabs.length ? tabs[0] : null;
}

async function detectFollowedTab(sourceTabId, sourceWindowId, attempts = 6, intervalMs = 150) {
  for (let i = 0; i < attempts; i++) {
    if (intervalMs > 0) {
      await sleep(intervalMs);
    }

    const focusedActiveTab = await getLastFocusedActiveTab().catch(() => null);
    if (
      focusedActiveTab &&
      typeof focusedActiveTab.id === "number" &&
      focusedActiveTab.id !== sourceTabId &&
      !isDisallowedUrl(focusedActiveTab.url || "")
    ) {
      return { tabId: focusedActiveTab.id, windowId: focusedActiveTab.windowId };
    }

    if (typeof sourceWindowId === "number") {
      const windowActiveTab = await getActiveTabInWindow(sourceWindowId).catch(() => null);
      if (
        windowActiveTab &&
        typeof windowActiveTab.id === "number" &&
        windowActiveTab.id !== sourceTabId &&
        !isDisallowedUrl(windowActiveTab.url || "")
      ) {
        return { tabId: windowActiveTab.id, windowId: windowActiveTab.windowId };
      }
    }
  }

  return null;
}

async function adoptAgentTab(currentTabId, currentWindowId, action, executed) {
  let targetTabId = currentTabId;
  let targetWindowId = currentWindowId;
  let reason = "";

  if (executed && typeof executed.followedTabId === "number" && executed.followedTabId !== currentTabId) {
    targetTabId = executed.followedTabId;
    targetWindowId = executed.followedWindowId ?? currentWindowId;
    reason = "followed_click";
  } else if (action === "switch_tab") {
    const activeTab = await getActiveTabInWindow(currentWindowId).catch(() => null);
    if (activeTab && typeof activeTab.id === "number" && activeTab.id !== currentTabId) {
      targetTabId = activeTab.id;
      targetWindowId = activeTab.windowId;
      reason = "switch_tab";
    }
  }

  if (targetTabId === currentTabId) {
    return { tabId: currentTabId, windowId: currentWindowId, moved: false, reason: "" };
  }

  moveSessionState(currentTabId, targetTabId);
  try {
    await notifyAgentUi(currentTabId, false);
  } catch (_) {}
  try {
    await notifyAgentUi(targetTabId, true);
  } catch (_) {}

  debugLog("agent.tab_follow", {
    reason,
    from_tab_id: currentTabId,
    to_tab_id: targetTabId,
  });
  return { tabId: targetTabId, windowId: targetWindowId, moved: true, reason };
}

async function runSimpleCommand(cmd, targetTabId = null) {
  if (!cmd) return;
  const tab =
    typeof targetTabId === "number"
      ? await getTabById(targetTabId)
      : await getActiveTab();
  if (!tab) {
    console.warn("[router] No active tab for simple command");
    return null;
  }

  switch (cmd.kind) {
    case "show_overlays":
      await enableManualOverlayMode(tab.id);
      return { tabId: tab.id };
    case "hide_overlays":
      await disableManualOverlayMode();
      return { tabId: tab.id };
    case "scroll": {
      const executed = await runSimpleContentAction(tab.id, "scroll", cmd.value);
      if (executed.ok && isManualOverlayActiveForTab(tab.id)) {
        scheduleManualOverlayRefreshCycle(tab.id);
      }
      return { tabId: tab.id };
    }
    case "click_index": {
      if (cmd.source === "overlay_numeric" && !isManualOverlayActiveForTab(tab.id)) {
        console.warn("[overlay] Ignoring numeric overlay click outside the active overlay tab");
        return { tabId: tab.id };
      }
      const overlayModeWasActive = isManualOverlayActiveForTab(tab.id);
      if (overlayModeWasActive) {
        manualOverlayFollowUntil = Date.now() + 2000;
      }
      const executed = await runSimpleContentAction(tab.id, "click_index", cmd.value);
      if (executed.ok && overlayModeWasActive) {
        const followedTab = await detectFollowedTab(tab.id, tab.windowId);
        if (followedTab) {
          manualOverlayTabId = followedTab.tabId;
        }
        manualOverlayFollowUntil = 0;
        const refreshTabId = followedTab?.tabId ?? tab.id;
        scheduleManualOverlayRefreshCycle(refreshTabId);
        return { tabId: refreshTabId };
      }
      return { tabId: tab.id };
    }
    case "tab": {
      const switched = await new Promise((resolve) => {
        chrome.tabs.query({ active: true }, (tabs) => {
          const active = tabs[0];
          if (!active) {
            resolve(null);
            return;
          }
          chrome.tabs.query({}, (all) => {
            const idx = all.findIndex((t) => t.id === active.id);
            if (idx === -1) {
              resolve(null);
              return;
            }
            const nextIdx = cmd.value === "next" ? (idx + 1) % all.length : (idx - 1 + all.length) % all.length;
            const target = all[nextIdx];
            if (!target) {
              resolve(null);
              return;
            }
            chrome.tabs.update(target.id, { active: true }, () => resolve(target.id));
          });
        });
      });
      return { tabId: switched ?? tab.id };
    }
    case "switch_tab": {
      const switched = await new Promise((resolve) => {
        chrome.tabs.query({}, (tabs) => {
          const target = tabs[cmd.value - 1];
          if (!target) {
            resolve(null);
            return;
          }
          chrome.tabs.update(target.id, { active: true }, () => resolve(target.id));
        });
      });
      return { tabId: switched ?? tab.id };
    }
    case "search": {
      const q = cmd.value;
      const url = q.includes(".") ? (q.startsWith("http") ? q : `https://${q}`) : `https://www.google.com/search?q=${encodeURIComponent(q)}`;
      const created = await new Promise((resolve) => {
        chrome.tabs.create({ url }, (createdTab) => resolve(createdTab || null));
      });
      return { tabId: typeof created?.id === "number" ? created.id : tab.id };
    }
    case "open_url": {
      const url = cmd.value.startsWith("http") ? cmd.value : `https://${cmd.value}`;
      const created = await new Promise((resolve) => {
        chrome.tabs.create({ url }, (createdTab) => resolve(createdTab || null));
      });
      return { tabId: typeof created?.id === "number" ? created.id : tab.id };
    }
    default:
      return { tabId: tab.id };
  }
}

async function classifyIntent(text) {
  if (!text) return null;
  try {
    const res = await fetch(INTENT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const action = data && data.action;
    const value = data ? data.value : null;
    if (!action) return null;

    // Map intent action/value to runSimpleCommand payload
    switch (action) {
      case "show_overlays":
        if (/\boverlays?\b/.test((text || "").toLowerCase())) {
          return { kind: "show_overlays" };
        }
        return null;
      case "hide_overlays":
        if (/\boverlays?\b/.test((text || "").toLowerCase())) {
          return { kind: "hide_overlays" };
        }
        return null;
      case "scroll":
        if (typeof value === "string") return { kind: "scroll", value };
        return null;
      case "click_index":
        if (Number.isInteger(value)) return { kind: "click_index", value };
        return null;
      case "switch_tab":
        if (value === "next" || value === "prev") return { kind: "tab", value };
        if (Number.isInteger(value)) return { kind: "switch_tab", value };
        return null;
      case "search":
        if (typeof value === "string") return { kind: "search", value };
        return null;
      case "open_url":
        if (typeof value === "string") return { kind: "open_url", value };
        return null;
      default:
        return null;
    }
  } catch (err) {
    console.warn("[intent] classify failed:", err);
    return null;
  }
}

async function summarizeScreenshot(questionText, targetTabId = null, { keepSession = false } = {}) {
  const tab =
    typeof targetTabId === "number"
      ? await getTabById(targetTabId)
      : await getActiveTab();
  if (!tab) {
    console.warn("[summarize] No active tab to capture");
    return;
  }
  if (isDisallowedUrl(tab.url)) {
    console.warn("[summarize] Cannot capture chrome:// or extension pages");
    return;
  }

  let screenshotDataUrl = "";
  try {
    screenshotDataUrl = await captureVisibleTab(tab.windowId);
  } catch (err) {
    console.error("[summarize] Failed to capture screenshot:", err);
    return;
  }

  try {
    const answer = await callSummarizeLLM({
      question: questionText || "Summarize the visible page.",
      screenshotDataUrl,
    });
    console.log("[summarize] Answer:", answer);
    // store last summary for this tab
    const state = getOrCreateSession(tab.id);
    state.lastSummary = (answer || "").slice(0, 500);
    setPendingSummarySession(tab.id, keepSession);

    fireAndForgetTabMessage(tab.id, { type: "UI_RESPONSE_SHOW", text: answer || "" }, 0);
    fireAndForgetTabMessage(tab.id, { type: "SHOW_SUMMARY", summary: answer }, 0);
    // Speak the summary (fire and forget) in background; pill collapses when PLAY_TTS ends (handled in content).
    speakText(answer || "").then((audioUrl) => {
      if (audioUrl) {
        fireAndForgetTabMessage(tab.id, { type: "PLAY_TTS", audioUrl }, 0);
      } else {
        finalizeSummaryVoiceState(tab.id, consumePendingSummarySession(tab.id));
      }
    }).catch(() => {
      finalizeSummaryVoiceState(tab.id, consumePendingSummarySession(tab.id));
    });
  } catch (err) {
    console.error("[summarize] Summarization failed:", err);
    finalizeSummaryVoiceState(tab.id, consumePendingSummarySession(tab.id));
  }
}

async function callSummarizeLLM(payload) {
  const body = {
    question: payload.question,
    screenshotDataUrl: payload.screenshotDataUrl,
  };

  const res = await fetch(SUMMARIZE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Summarize HTTP error: ${res.status}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }

  if (data && typeof data.answer === "string") return data.answer;
  const text = data && typeof data === "string" ? data : "";
  return text || "No summary available.";
}

async function observeControllerTab({ tabId, windowId, url, title }) {
  let observation = await observeTab({
    tabId,
    windowId,
    url,
    title,
  });
  if (observation && Array.isArray(observation.elements) && observation.elements.length <= 1) {
    const retried = await observeTab({
      tabId,
      windowId,
      url,
      title,
      waitMs: 350,
      frameId: observation.frameId || 0,
    });
    if (retried) {
      observation = retried;
    }
  }
  return observation;
}

async function showTaskQuestion(tabId, questionPayload) {
  const questionText = getPendingQuestionText(questionPayload);
  if (!questionText) return;
  try {
    fireAndForgetTabMessage(tabId, { type: "SHOW_QUESTION", question: questionText }, 0);
    speakText(questionText).then((audioUrl) => {
      if (audioUrl) {
        fireAndForgetTabMessage(tabId, { type: "PLAY_TTS", audioUrl }, 0);
      }
    }).catch(() => {});
  } catch (_) {}
}

async function finalizeTaskSession(tabId) {
  const shouldClearActiveState = activeAgentTabId === tabId;
  if (shouldClearActiveState) {
    activeAgentTabId = null;
    activeAgentMode = null;
    isAgentRunning = false;
    console.log("[agent] Stopped");
  }
  try {
    const tab = await getTabById(tabId);
    if (tab) {
      const keepLatchedSession = hasLatchedWakeForTab(tab.id);
      await notifyAgentUi(tab.id, false);
      if (keepLatchedSession) {
        beginSessionListening(tab.id);
      } else {
        endVoiceSession(tab.id);
      }
    }
  } catch (_) {}
}

function recordControllerFailure(taskState, session, action, summary, detail, verification = null) {
  const failureDetail = detail || summary || "controller_failure";
  const failures = incrementControllerFailure(session);
  taskState.error = failureDetail;
  updateTaskLastStep(taskState, action, summary || failureDetail, {
    status: "failed",
    verification,
    detail: failureDetail,
  });
  appendHistory(taskState, summary || failureDetail);
  session.lastSummary = taskState.last_step.summary;
  if (action) {
    session.lastAction = {
      action: action.type,
      value: action.value,
      info: failureDetail,
    };
  }
  if (failures >= MAX_CONTROLLER_FAILURES) {
    taskState.task_status = "failed";
  }
  return failures;
}

function recordSuccessfulStep(taskState, session, action, summary, verification, detail) {
  resetControllerFailureState(session);
  updateTaskLastStep(taskState, action, summary, {
    status: "executed",
    verification,
    detail,
  });
  appendHistory(taskState, summary);
  session.lastSummary = taskState.last_step.summary;
}

async function runTaskStateControllerLoop({ agentTabId, agentWindowId, runId }) {
  let taskTabId = agentTabId;
  let taskWindowId = agentWindowId;
  const session = getOrCreateSession(taskTabId);
  debugLog("controller.loop.start", {
    tab_id: taskTabId,
    window_id: taskWindowId,
    run_id: runId,
    task_state: debugTaskStateSnapshot(getCurrentTaskState(taskTabId)),
  });

  // state_revision is the controller's revision lock. Any worker result produced for an older
  // revision is discarded before it can execute actions or mutate memory.
  while (session.controllerRunId === runId) {
    const taskState = getCurrentTaskState(taskTabId);
    if (!taskState || taskState.task_status !== "running") {
      break;
    }

    const currentTab = await getTabById(taskTabId);
    if (!currentTab) {
      taskState.task_status = "failed";
      taskState.error = "Agent tab no longer exists";
      updateTaskLastStep(taskState, null, "Task failed because the tab closed.", {
        status: "failed",
        verification: null,
        detail: "Agent tab no longer exists",
      });
      appendHistory(taskState, taskState.last_step.summary);
      break;
    }

    if (isDisallowedUrl(currentTab.url)) {
      taskState.task_status = "failed";
      taskState.error = "Cannot run agent on chrome:// or extension pages";
      updateTaskLastStep(taskState, null, "Task failed because the current page is not injectable.", {
        status: "failed",
        verification: null,
        detail: taskState.error,
      });
      appendHistory(taskState, taskState.last_step.summary);
      break;
    }

    const observation = await observeControllerTab({
      tabId: taskTabId,
      windowId: taskWindowId,
      url: currentTab.url,
      title: currentTab.title,
    });

    if (!observation) {
      recordControllerFailure(taskState, session, null, "Observation failed.", "Could not observe the page.", null);
      if (taskState.task_status === "failed") break;
      await sleep(250);
      continue;
    }

    session.lastPageContext = observation.pageContext || session.lastPageContext || "";
    await notifyAgentUi(taskTabId, true);
    const workerInput = buildWorkerInput(taskState, observation);
    debugLog("worker.call.input", {
      tab_id: taskTabId,
      run_id: runId,
      worker_input: workerInput,
      task_state: debugTaskStateSnapshot(taskState),
    });

    let workerOutput;
    try {
      workerOutput = validateWorkerOutput(await self.requestWorkerStep({
        workerPrompt: self.WORKER_PROMPT || "",
        workerInput,
      }), taskState.state_revision);
      debugLog("worker.call.output", {
        tab_id: taskTabId,
        run_id: runId,
        worker_output: workerOutput,
      });
    } catch (err) {
      const errorMessage = err?.message || "worker_output_invalid";
      debugLog("worker.call.error", {
        tab_id: taskTabId,
        run_id: runId,
        error: errorMessage,
        worker_input: workerInput,
        task_state: debugTaskStateSnapshot(taskState),
      });
      recordControllerFailure(
        taskState,
        session,
        null,
        classifyWorkerFailureSummary(errorMessage),
        errorMessage,
        null
      );
      if (taskState.task_status === "failed") break;
      await sleep(250);
      continue;
    }

    if (session.controllerRunId !== runId) {
      return;
    }

    const latestTaskState = getCurrentTaskState(taskTabId);
    if (discardStaleWorkerOutput(latestTaskState, workerOutput)) {
      debugLog("worker.call.stale", {
        tab_id: taskTabId,
        run_id: runId,
        current_revision: latestTaskState?.state_revision,
        worker_revision: workerOutput?.state_revision,
      });
      console.log("[controller] Discarded stale worker output for revision", workerOutput?.state_revision);
      continue;
    }

    const action = workerOutput.action;
    const summary = workerOutput.summary;
    const verification = workerOutput.verification;
    const issue = workerOutput.issue || "";
    const subgoalDone = workerOutput.subgoal_done || action.type === "done";

    if (action.type === "ask_user" && !workerOutput.needs_user) {
      recordControllerFailure(
        latestTaskState,
        session,
        action,
        "Worker asked for user input with no needs_user payload.",
        "ask_user requires needs_user",
        verification
      );
      if (latestTaskState.task_status === "failed") break;
      await sleep(250);
      continue;
    }

    if (workerOutput.needs_user) {
      // Task-state transitions stay in controller code so the worker can only request waiting_user,
      // never set it directly on the canonical TaskState.
      latestTaskState.task_status = "waiting_user";
      latestTaskState.pending_question = workerOutput.needs_user;
      latestTaskState.error = issue || null;
      updateTaskLastStep(latestTaskState, action, summary, {
        status: "needs_user",
        verification,
        detail: getPendingQuestionText(workerOutput.needs_user),
      });
      appendHistory(latestTaskState, summary);
      session.lastSummary = latestTaskState.last_step.summary;
      session.lastAction = {
        action: action.type,
        value: action.value,
        info: "waiting_user",
      };
      await showTaskQuestion(taskTabId, workerOutput.needs_user);
      break;
    }

    if (action.type === "report_error") {
      recordControllerFailure(
        latestTaskState,
        session,
        action,
        summary,
        action.value || issue || "worker_report_error",
        verification
      );
      if (latestTaskState.task_status === "failed") break;
      await sleep(250);
      continue;
    }

    let executed = { ok: true, info: "subgoal_done" };
    if (action.type !== "done") {
      executed = await executeAction(
        taskTabId,
        action.type,
        action.value,
        session.actionHistory,
        observation.elements || [],
        currentTab.url || "",
        session,
        observation.frameId || 0
      );
    }

    if (!executed || executed.ok !== true) {
      recordControllerFailure(
        latestTaskState,
        session,
        action,
        summary,
        (executed && executed.error) || "action_failed",
        verification
      );
      if (latestTaskState.task_status === "failed") break;
      await sleep(250);
      continue;
    }

    // Worker proposes and the controller writes. Memory updates are patch-only and never replace
    // the full memory object.
    applyMemoryPatch(latestTaskState, workerOutput.memory_patch);
    recordSuccessfulStep(
      latestTaskState,
      session,
      action,
      summary,
      verification,
      executed.info || summary
    );
    const recoveredFromFailure = cleanupRecoveryContext(
      latestTaskState,
      workerOutput,
      executed.info || summary
    );
    session.lastSummary = latestTaskState.last_step?.summary || session.lastSummary;
    session.lastAction = {
      action: action.type,
      value: action.value,
      info: executed.info || "",
    };
    const followedTarget = await adoptAgentTab(taskTabId, taskWindowId, action.type, executed);
    taskTabId = followedTarget.tabId;
    taskWindowId = followedTarget.windowId;

    latestTaskState.pending_question = null;
    latestTaskState.error = recoveredFromFailure
      ? null
      : (verification === "passed" ? null : (issue || null));

    if (subgoalDone) {
      const nextSubgoal = advanceSubgoal(latestTaskState);
      latestTaskState.last_step.result.status = nextSubgoal ? "executed" : "completed";
      if (!nextSubgoal) {
        latestTaskState.task_status = "completed";
        latestTaskState.error = null;
        break;
      }
    }

    await sleep(100);
  }

  const latestTaskState = getCurrentTaskState(taskTabId);
  debugLog("controller.loop.stop", {
    tab_id: taskTabId,
    window_id: taskWindowId,
    run_id: runId,
    task_state: debugTaskStateSnapshot(latestTaskState),
  });
  if (session.controllerRunId === runId && latestTaskState && isTerminalTaskStatus(latestTaskState.task_status)) {
    await finalizeTaskSession(taskTabId);
  }
}

function startTaskStateLoop(agentTabId, agentWindowId) {
  const session = getOrCreateSession(agentTabId);
  const runId = currentControllerRunId(session);
  runTaskStateControllerLoop({ agentTabId, agentWindowId, runId }).catch(async (err) => {
    console.error("[controller] loop crashed:", err);
    const finalTabId = activeAgentTabId !== null ? activeAgentTabId : agentTabId;
    const taskState = getCurrentTaskState(finalTabId);
    if (taskState) {
      taskState.task_status = "failed";
      taskState.error = err?.message || "controller_loop_crash";
      updateTaskLastStep(taskState, null, "Task failed because the controller crashed.", {
        status: "failed",
        verification: null,
        detail: taskState.error,
      });
      appendHistory(taskState, taskState.last_step.summary);
    }
    await finalizeTaskSession(finalTabId);
  });
  return runId;
}

async function initializeTaskStateAgent({ goalText, agentTabId, agentWindowId, session }) {
  const currentTab = await getTabById(agentTabId);
  if (!currentTab) {
    throw new Error("Agent tab no longer exists");
  }

  session.actionHistory = [];
  session.askCache = {};
  resetControllerFailureState(session);

  let observation = null;
  try {
    observation = await observeControllerTab({
      tabId: agentTabId,
      windowId: agentWindowId,
      url: currentTab.url,
      title: currentTab.title,
    });
  } catch (_) {
    observation = null;
  }

  const orchestratorInitInput = buildOrchestratorInitInput(goalText, observation);
  debugLog("orchestrator.init.input", {
    goal: goalText,
    tab_id: agentTabId,
    browser_context: orchestratorInitInput.browserContext,
  });
  const initialTaskState = validateOrchestratorOutput(await self.requestOrchestrator(
    orchestratorInitInput
  ), "initialize");
  debugLog("orchestrator.init.output", {
    goal: goalText,
    tab_id: agentTabId,
    task_state: debugTaskStateSnapshot(initialTaskState),
  });

  setCurrentTaskState(agentTabId, initialTaskState);
  session.lastSummary = "";
  session.lastUserReply = "";
  session.lastAction = null;
  session.lastStepNote = "";
  session.lastPageContext = observation?.pageContext || "";

  activeAgentTabId = agentTabId;
  isAgentRunning = true;
  await notifyAgentUi(agentTabId, true);
  if (initialTaskState.pending_question) {
    initialTaskState.task_status = "waiting_user";
    await showTaskQuestion(agentTabId, initialTaskState.pending_question);
    return;
  }
  startTaskStateLoop(agentTabId, agentWindowId);
}

async function mutateTaskFromUserText(tabId, userText) {
  const session = getOrCreateSession(tabId);
  const taskState = getCurrentTaskState(tabId);
  if (!taskState) {
    throw new Error("No active task to mutate");
  }

  session.controllerRunId = (session.controllerRunId || 0) + 1;
  taskState.task_status = "paused";

  const currentTab = await getTabById(tabId);
  const observation = currentTab && !isDisallowedUrl(currentTab.url)
    ? await observeControllerTab({
        tabId,
        windowId: currentTab.windowId,
        url: currentTab.url,
        title: currentTab.title,
      }).catch(() => null)
    : null;
  debugLog("orchestrator.mutate.input", {
    tab_id: tabId,
    user_text: userText,
    task_state: debugTaskStateSnapshot(taskState),
    browser_context: buildBrowserContext(observation),
  });

  const orchestratorMutateInput = buildOrchestratorInterruptInput(taskState, userText, observation);
  const mutationResult = validateOrchestratorOutput(await self.requestOrchestrator(
    orchestratorMutateInput
  ), "mutate");
  debugLog("orchestrator.mutate.output", {
    tab_id: tabId,
    user_text: userText,
    mutation: mutationResult,
  });

  applyInterruptMutation(taskState, mutationResult, userText);
  session.lastUserReply = userText;
  activeAgentTabId = tabId;
  activeAgentMode = "task_state";
  isAgentRunning = true;
  await notifyAgentUi(tabId, true);

  if (taskState.task_status === "waiting_user" && taskState.pending_question) {
    await showTaskQuestion(tabId, taskState.pending_question);
    return;
  }

  if (taskState.task_status === "running" && currentTab) {
    startTaskStateLoop(tabId, currentTab.windowId);
    return;
  }

  if (taskState.task_status === "running" && !currentTab) {
    taskState.task_status = "failed";
    taskState.error = "Agent tab no longer exists";
  }

  if (isTerminalTaskStatus(taskState.task_status)) {
    await finalizeTaskSession(tabId);
  }
}

async function interruptActiveTask(userText, nextMode = "task_state") {
  if (!isAgentRunning || activeAgentTabId === null) {
    await startAgent(userText, undefined, nextMode);
    return;
  }

  if (activeAgentMode === "task_state") {
    await mutateTaskFromUserText(activeAgentTabId, userText);
    return;
  }

  if (activeAgentMode === "baseline" || activeAgentMode === "planner_executor") {
    const restartTab = await getTabById(activeAgentTabId);
    invalidateNonTaskAgentRuns();
    isAgentRunning = false;
    activeAgentMode = null;
    activeAgentTabId = null;
    await startAgent(
      userText,
      restartTab && typeof restartTab.id === "number" && restartTab.windowId !== undefined
        ? { tabId: restartTab.id, windowId: restartTab.windowId }
        : undefined,
      nextMode
    );
    return;
  }

  await startAgent(userText, undefined, nextMode);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === MSG_TYPES.START_AGENT) {
    startAgent(msg.goalText || "", undefined, msg.mode).catch((e) => console.error("[agent] crashed:", e));
    return;
  }

  if (msg.type === "VOICE_CAPTURE_START") {
    const tabId = typeof sender?.tab?.id === "number" ? sender.tab.id : null;
    if (tabId !== null) {
      if (msg.captureMode === "session") {
        beginSessionListening(tabId);
      } else if (msg.captureMode === "interrupt") {
        beginInterruptListening(voiceState.sessionTabId ?? activeAgentTabId ?? tabId);
      } else if (msg.captureMode === "simple") {
        beginSimpleListening(tabId);
      }
    }
    sendResponse?.({ success: true });
    return;
  }

  if (msg.type === "VOICE_CAPTURE_STOP") {
    const tabId = typeof sender?.tab?.id === "number" ? sender.tab.id : null;
    if (tabId !== null) {
      const preserveSession = !!msg.preserveSession;
      const sessionStopRequested = msg.captureMode === "session" || preserveSession;
      if (msg.captureMode === "interrupt" && (voiceState.sessionActive || preserveSession)) {
        const interruptTabId = voiceState.sessionTabId ?? activeAgentTabId ?? tabId;
        if (!voiceState.sessionActive && preserveSession) {
          markLatchedWakeSession(interruptTabId);
        }
        beginSessionProcessing(interruptTabId);
      } else if (sessionStopRequested) {
        const sessionTabId = voiceState.sessionTabId ?? tabId;
        if (!voiceState.sessionActive && preserveSession) {
          markLatchedWakeSession(sessionTabId);
        }
        if (voiceState.sessionActive) {
          pauseSessionListening(sessionTabId);
        } else if (msg.captureMode === "simple") {
          pauseSimpleListening(tabId);
        }
      } else if (msg.captureMode === "simple") {
        pauseSimpleListening(tabId);
      }
    }
    sendResponse?.({ success: true });
    return;
  }

  if (msg.type === "VOICE_STATE_REQUEST") {
    const tabId = typeof sender?.tab?.id === "number" ? sender.tab.id : null;
    sendResponse?.({
      success: true,
      voiceState: getVoiceStateSnapshotForTab(tabId),
    });
    return true;
  }

  if (msg.type === "TEXT_COMMAND") {
    const sourceTabId = typeof sender?.tab?.id === "number" ? sender.tab.id : null;
    handleTextCommand(msg.text || "", {
      sourceTabId,
      captureMode: typeof msg.captureMode === "string" ? msg.captureMode : null,
    }).catch((e) => console.error("[router] crashed:", e));
    return;
  }

  if (msg.type === "SUMMARY_TTS_DONE") {
    const tabId = typeof sender?.tab?.id === "number" ? sender.tab.id : null;
    if (tabId === null) {
      sendResponse?.({ success: false, error: "missing_tab" });
      return;
    }
    Promise.resolve()
      .then(async () => {
        const keepSession = consumePendingSummarySession(tabId) || hasLatchedWakeForTab(tabId);
        finalizeSummaryVoiceState(tabId, keepSession);
        sendResponse?.({ success: true });
      })
      .catch((err) => {
        sendResponse?.({ success: false, error: err?.message || "summary_tts_done_failed" });
      });
    return true;
  }

  if (msg.type === "START_AGENT_AT_URL") {
    startAgentAtUrl(msg.url, msg.goalText || "", msg.mode);
    return;
  }

  if (msg.type === "USER_REPLY") {
    const replyText = msg.reply || "";
    const replyTabId = typeof sender?.tab?.id === "number" ? sender.tab.id : activeAgentTabId;
    const taskState = typeof replyTabId === "number" ? getCurrentTaskState(replyTabId) : null;

    if (taskState && taskState.task_status === "waiting_user") {
      mutateTaskFromUserText(replyTabId, replyText)
        .then(() => sendResponse?.({ success: true }))
        .catch((err) => {
          console.error("[controller] failed to resume waiting task:", err);
          sendResponse?.({ success: false, error: err?.message || "resume_failed" });
        });
      return true;
    }

    if (pendingUserReplyResolver) {
      pendingUserReplyResolver(replyText);
      pendingUserReplyResolver = null;
      sendResponse?.({ success: true });
      return;
    }
  }

  if (msg.type === "broadcast-overlay-command") {
    broadcastOverlayCommand(msg);
    return;
  }

  handleLegacyMessage(msg);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === voiceState.sessionTabId || tabId === voiceState.targetTabId) {
    endVoiceSession();
  }

  if (tabId === manualOverlayTabId) {
    disableManualOverlayMode({ hide: false }).catch(() => {});
  }

  if (tabId === activeAgentTabId) {
    const taskState = getCurrentTaskState(tabId);
    if (taskState && !isTerminalTaskStatus(taskState.task_status)) {
      taskState.task_status = "failed";
      taskState.error = "Agent tab was closed";
      updateTaskLastStep(taskState, null, "Task failed because the tab was closed.", {
        status: "failed",
        verification: null,
        detail: taskState.error,
      });
      appendHistory(taskState, taskState.last_step.summary);
    }
    finalizeTaskSession(tabId).catch(() => {});
  }
  sessionState.delete(tabId);
});

async function broadcastOverlayCommand(msg) {
  const tab = await getActiveTab();
  if (!tab) return;

  chrome.tabs.sendMessage(
    tab.id,
    { type: "overlay-command", action: msg.action, index: msg.index },
    { frameId: 0 }
  );
}


function handleLegacyMessage(msg) {
  chrome.tabs.query({ currentWindow: true }, (tabs) => {
    if (msg.type === "switch-tab") {
      const targetTab = tabs[msg.index - 1];
      if (targetTab) chrome.tabs.update(targetTab.id, { active: true });
      return;
    }

    if (msg.type === "last-tab") {
      const lastTab = tabs[tabs.length - 1];
      if (lastTab) chrome.tabs.update(lastTab.id, { active: true });
      return;
    }

    if (msg.type === "next-tab" || msg.type === "previous-tab") {
      chrome.tabs.query({ currentWindow: true, active: true }, (activeTabs) => {
        const activeTab = activeTabs[0];
        const currentIndex = tabs.findIndex((tab) => tab.id === activeTab.id);

        if (msg.type === "next-tab") {
          const next = tabs[(currentIndex + 1) % tabs.length];
          chrome.tabs.update(next.id, { active: true });
        } else {
          const prev = tabs[(currentIndex - 1 + tabs.length) % tabs.length];
          chrome.tabs.update(prev.id, { active: true });
        }
      });
      return;
    }

    if (msg.type === "reopen-tab") {
      chrome.sessions.restore();
      return;
    }

    if (msg.type === "search-query") {
      const query = msg.query.toLowerCase();
      let url;

      if (query.includes(".")) {
        url = query.startsWith("http") ? query : `https://${query}`;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      }

      chrome.tabs.create({ url });
      return;
    }

    if (msg.type === "close-tab") {
      chrome.tabs.query({ currentWindow: true, active: true }, (activeTabs) => {
        const currentTab = activeTabs[0];
        if (currentTab) chrome.tabs.remove(currentTab.id);
      });
    }
  });
}

async function startAgent(goalText, lockedTarget, mode) {
  if (isAgentRunning) {
    console.warn("[agent] Already running; ignoring START_AGENT");
    return;
  }

  let initialTab;
  if (lockedTarget && lockedTarget.tabId && lockedTarget.windowId !== undefined) {
    initialTab = await getTabById(lockedTarget.tabId);
    if (!initialTab) {
      console.warn("[agent] Locked tab not found; cannot start");
      return;
    }
  } else {
    initialTab = await getActiveTab();
  }

  if (!initialTab || !initialTab.id || initialTab.windowId === undefined) {
    console.warn("[agent] No active tab found; cannot start");
    return;
  }

  if (isDisallowedUrl(initialTab.url)) {
    console.error("[agent] Cannot run agent on chrome:// pages; switch to a normal website tab and restart");
    return;
  }

  if (manualOverlayMode) {
    await disableManualOverlayMode();
  }

  const agentTabId = lockedTarget?.tabId ?? initialTab.id;
  const agentWindowId = lockedTarget?.windowId ?? initialTab.windowId;
  const agentMode = mode === "baseline"
    ? "baseline"
    : mode === "planner_executor"
      ? "planner_executor"
      : "task_state";
  const nonTaskRunToken = isTaskStateMode(agentMode) ? null : nextNonTaskAgentRunToken();

  isAgentRunning = true;
  activeAgentTabId = agentTabId;
  activeAgentMode = agentMode;
  console.log(
    "[agent] Starting agent with goal:",
    goalText,
    "tab:",
    agentTabId,
    "window:",
    agentWindowId,
    "mode:",
    agentMode
  );

  const state = getOrCreateSession(agentTabId);

  if (isTaskStateMode(agentMode)) {
    try {
      await initializeTaskStateAgent({
        goalText,
        agentTabId,
        agentWindowId,
        session: state,
      });
    } catch (err) {
      console.error("[agent] task_state init failed:", err);
      const taskState = getCurrentTaskState(agentTabId);
      if (taskState) {
        taskState.task_status = "failed";
        taskState.error = err?.message || "task_state_init_failed";
        updateTaskLastStep(taskState, null, "Task failed during initialization.", {
          status: "failed",
          verification: null,
          detail: taskState.error,
        });
        appendHistory(taskState, taskState.last_step.summary);
      }
      await finalizeTaskSession(agentTabId);
      throw err;
    }
    return;
  }

  await notifyAgentUi(agentTabId, true);

  try {
    if (agentMode === "planner_executor") {
      await runAgentPlannerExecutor({
        goalText,
        agentTabId,
        agentWindowId,
        state,
        runToken: nonTaskRunToken,
      });
    } else {
      await runAgentBaseline({
        goalText,
        agentTabId,
        agentWindowId,
        state,
        runToken: nonTaskRunToken,
      });
    }
  } finally {
    if (nonTaskRunToken === null || isCurrentNonTaskAgentRun(nonTaskRunToken)) {
      const finalTabId = activeAgentTabId !== null ? activeAgentTabId : agentTabId;
      isAgentRunning = false;
      activeAgentTabId = null;
      activeAgentMode = null;
      console.log("[agent] Stopped");
      try {
        const tab = await getTabById(finalTabId);
        if (tab) {
          const keepLatchedSession = hasLatchedWakeForTab(tab.id);
          await notifyAgentUi(tab.id, false);
          if (keepLatchedSession) {
            beginSessionListening(tab.id);
          } else {
            endVoiceSession(tab.id);
          }
        }
      } catch (_) {}
    }
  }
}

async function runAgentBaseline({ goalText, agentTabId, agentWindowId, state, runToken }) {
  const actionHistory = [];
  let consecutiveScrolls = 0;
  let pendingUserReply = "";
  let controlledTabId = agentTabId;
  let controlledWindowId = agentWindowId;
  const isCanceled = () => shouldStopNonTaskAgentRun(runToken);

  for (let step = 0; step < MAX_STEPS; step++) {
    if (isCanceled()) {
      console.log("[agent] Baseline run canceled; stopping");
      break;
    }

    const currentTab = await getTabById(controlledTabId);
    if (!currentTab) {
      console.warn("[agent] Agent tab no longer exists; stopping");
      break;
    }

    if (isDisallowedUrl(currentTab.url)) {
      console.error("[agent] Cannot run agent on chrome:// pages; switch to a normal website tab and restart");
      break;
    }

    const observeStart = Date.now();
    let observation = await observeTab({
      tabId: controlledTabId,
      windowId: controlledWindowId,
      url: currentTab.url,
      title: currentTab.title,
    });
    logTiming("observeTab", observeStart, 250);
    if (observation && typeof observation.pageContext === "string") {
      console.log("[agent] pageContext:", observation.pageContext);
    }
    if (!observation) {
      console.warn("[agent] Observation failed; stopping");
      break;
    }
    if (isCanceled()) {
      console.log("[agent] Baseline run canceled after observation; stopping");
      break;
    }
    await notifyAgentUi(controlledTabId, true);
    if (!observation.elements || observation.elements.length <= 1) {
      console.warn("[agent] Low candidate count (<=1); re-observing once");
      const fallbackInfo = await triggerShowShortcut(controlledTabId);
      const targetFrameId = fallbackInfo?.frameId ?? 0;
      const retryStart = Date.now();
      const retryObs = await observeTab({
        tabId: controlledTabId,
        windowId: controlledWindowId,
        url: currentTab.url,
        title: currentTab.title,
        waitMs: 6000,
        frameId: targetFrameId,
      });
      logTiming("observeTab_retry", retryStart, 250);
      if (retryObs && typeof retryObs.pageContext === "string") {
        console.log("[agent] pageContext (retry):", retryObs.pageContext);
      }
      if (!retryObs || !retryObs.elements || retryObs.elements.length <= 3) {
        console.warn("[agent] No sufficient overlays after re-observe; stopping");
        break;
      }
      const shot = fallbackInfo?.screenshotDataUrl || retryObs.screenshotDataUrl;
      observation = {
        ...retryObs,
        screenshotDataUrl: shot,
        frameId: targetFrameId,
      };
      await notifyAgentUi(controlledTabId, true);
      console.log(
        "[agent] Fallback observation succeeded; frame:",
        targetFrameId,
        "candidates:",
        retryObs.elements.length,
        "screenshot len:",
        shot ? shot.length : 0
      );
    }
    if (isCanceled()) {
      console.log("[agent] Baseline run canceled after fallback observation; stopping");
      break;
    }

    let decision;
    try {
      const decisionStart = Date.now();
      decision = await getNextAction({
        goalText,
        screenshotDataUrl: observation.screenshotDataUrl,
        url: currentTab.url || "",
        title: currentTab.title || "",
        actionHistory: actionHistory.slice(-5),
        elements: observation.elements || [],
        userReply: pendingUserReply,
        pageContext: observation.pageContext || state.lastPageContext || "",
        lastSummary: state.lastSummary || "",
        lastAction: state.lastAction || null,
        lastStepNote: state.lastStepNote || "",
        userProfile: USER_PROFILE,
      });
      logTiming("getNextAction", decisionStart, 300);
      pendingUserReply = "";
    } catch (err) {
      console.error("[agent] Decision error:", err);
      break;
    }
    if (isCanceled()) {
      console.log("[agent] Baseline run canceled after decision; stopping");
      break;
    }

    if (!decision || typeof decision.action !== "string") {
      console.warn("[agent] Invalid decision payload; stopping");
      break;
    }

    let { action, value } = decision;
    console.log("[agent] Step", step + 1, "- decided:", decision);

    if (action === "done") {
      console.log("[agent] Goal complete; stopping");
      break;
    }
    if (action === "report_error") {
      console.warn("[agent] report_error from LLM:", value);
      break;
    }

    if (action === "ask_user") {
      const auto = await autoAnswerAskUser(value || "");
      if (auto) {
        actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${auto.slice(0, 80)}`, true));
        updateLastAction(state, action, value, "user_reply_captured");
        updateLastStepNote(state, decision);
        pendingUserReply = auto;
        if (isCanceled()) {
          console.log("[agent] Baseline run canceled after auto-answer; stopping");
          break;
        }
        continue;
      }
      const reply = await promptUser(value, controlledTabId);
      if (!reply) {
        console.warn("[agent] No user reply; stopping");
        break;
      }
      if (isCanceled()) {
        console.log("[agent] Baseline run canceled after user reply; stopping");
        break;
      }
      actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${reply.slice(0, 80)}`, true));
      updateLastAction(state, action, value, "user_reply_captured");
      updateLastStepNote(state, decision);
      pendingUserReply = reply;
      continue;
    }

    const execStart = Date.now();
    const executed = await executeAction(
      controlledTabId,
      action,
      value,
      actionHistory,
      observation.elements || [],
      currentTab.url || "",
      state,
      observation.frameId || 0
    );
    logTiming("executeAction", execStart, 200);
    if (!executed || executed.ok !== true) {
      const errMsg = (executed && executed.error) || "action_failed";
      if (errMsg.toLowerCase().includes("no candidate found")) {
        const recovery = await runBaselineRecovery({
          goalText,
          agentTabId: controlledTabId,
          agentWindowId: controlledWindowId,
          actionHistory,
          pendingUserReply,
          state,
          lastError: errMsg,
          frameId: observation.frameId || 0,
          runToken,
        });
        if (recovery && recovery.recovered) {
          controlledTabId = recovery.agentTabId;
          controlledWindowId = recovery.agentWindowId;
          continue;
        }
      }
      console.warn("[agent] Action failed; stopping");
      break;
    }
    const followedTarget = await adoptAgentTab(controlledTabId, controlledWindowId, action, executed);
    controlledTabId = followedTarget.tabId;
    controlledWindowId = followedTarget.windowId;
    if (isCanceled()) {
      console.log("[agent] Baseline run canceled after action execution; stopping");
      break;
    }
    updateLastStepNote(state, decision);

    consecutiveScrolls = action === "scroll" ? consecutiveScrolls + 1 : 0;

    if (consecutiveScrolls > MAX_CONSECUTIVE_SCROLLS) {
      console.warn("[agent] Too many consecutive scroll actions; stopping");
      break;
    }
  }
}

async function runBaselineRecovery({ goalText, agentTabId, agentWindowId, actionHistory, pendingUserReply, state, lastError, frameId = 0, runToken }) {
  const isCanceled = () => shouldStopNonTaskAgentRun(runToken);
  let controlledTabId = agentTabId;
  let controlledWindowId = agentWindowId;
  try {
    if (isCanceled()) return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
    const tab = await getTabById(controlledTabId);
    if (!tab) return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
    const observation = await observeTab({
      tabId: controlledTabId,
      windowId: controlledWindowId,
      url: tab.url,
      title: tab.title,
      frameId,
    });
    if (!observation) return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
    if (isCanceled()) return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };

    let statusResp;
    try {
      statusResp = await self.requestStatus({
        statusPrompt: self.STATUS_PROMPT || "",
        goalText: goalText || "",
        screenshotDataUrl: observation.screenshotDataUrl || "",
        meta: {
          url: observation.url || tab.url || "",
          title: observation.title || tab.title || "",
          pageContext: observation.pageContext || "",
          elements: observation.elements || [],
          actionHistory: actionHistory.slice(-5),
          userReply: pendingUserReply || "",
          lastSummary: state.lastSummary || "",
          lastAction: state.lastAction || null,
          lastStepNote: state.lastStepNote || "",
          userProfile: USER_PROFILE,
        },
      });
    } catch (err) {
      console.warn("[agent][status] Status check failed:", err);
      statusResp = null;
    }
    if (isCanceled()) return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };

    if (statusResp && statusResp.status === "done") {
      console.log("[agent][status] Goal already satisfied per status check; stopping");
      return { recovered: true, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
    }

    const missingNote = (statusResp && typeof statusResp.missing === "string" && statusResp.missing) || lastError || "";
    console.warn("[agent][status] Retry after status check; missing:", missingNote);

    let retryDecision;
    try {
      retryDecision = await self.requestAgentStep({
        goalText,
        screenshotDataUrl: observation.screenshotDataUrl || "",
        url: observation.url || tab.url || "",
        title: observation.title || tab.title || "",
        actionHistory: actionHistory.slice(-5),
        elements: observation.elements || [],
        userReply: pendingUserReply,
        pageContext: observation.pageContext || state.lastPageContext || "",
        lastSummary: state.lastSummary || "",
        lastAction: state.lastAction || null,
        lastStepNote: state.lastStepNote || "",
        lastError: missingNote,
        userProfile: USER_PROFILE,
      });
    } catch (err) {
      console.error("[agent][status] Retry decision failed:", err);
      return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
    }
    if (isCanceled()) return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };

    if (!retryDecision || typeof retryDecision.action !== "string") {
      console.warn("[agent][status] Invalid retry decision");
      return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
    }

    const executed = await executeAction(
      controlledTabId,
      retryDecision.action,
      retryDecision.value,
      actionHistory,
      observation.elements || [],
      observation.url || tab.url || "",
      state,
      observation.frameId || frameId || 0
    );
    if (isCanceled()) return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
    if (!executed || executed.ok !== true) {
      console.warn("[agent][status] Retry execute failed");
      return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
    }
    const followedTarget = await adoptAgentTab(controlledTabId, controlledWindowId, retryDecision.action, executed);
    controlledTabId = followedTarget.tabId;
    controlledWindowId = followedTarget.windowId;
    updateLastStepNote(state, retryDecision);

    console.log("[agent][status] Retry succeeded");
    return { recovered: true, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
  } catch (err) {
    console.warn("[agent][status] Recovery error:", err);
    return { recovered: false, agentTabId: controlledTabId, agentWindowId: controlledWindowId };
  }
}

async function runAgentPlannerExecutor({ goalText, agentTabId, agentWindowId, state, runToken }) {
  const actionHistory = [];
  let pendingUserReply = "";
  let lastError = "";
  let lastObservation = null;
  let controlledTabId = agentTabId;
  let controlledWindowId = agentWindowId;
  const isCanceled = () => shouldStopNonTaskAgentRun(runToken);

  const metrics = {
    startTime: Date.now(),
    stepsExecuted: 0,
    observeCalls: 0,
    plannerCalls: 0,
    executorCalls: 0,
    fallbackCalls: 0,
    observeDurations: [],
    plannerDurations: [],
    executorDurations: [],
  };

  const recordObservation = async () => {
    const tab = await getTabById(controlledTabId);
    if (!tab) return null;
    const t0 = Date.now();
    const observation = await observeTab({
      tabId: controlledTabId,
      windowId: controlledWindowId,
      url: tab.url,
      title: tab.title,
    });
    metrics.observeCalls += 1;
    metrics.observeDurations.push(Date.now() - t0);
    logTiming("observeTab_planner", t0, 250);
    if (observation && typeof observation.pageContext === "string") {
      console.log("[agent] pageContext:", observation.pageContext);
    }
    if (observation && observation.pageContext) {
      state.lastPageContext = observation.pageContext;
    }
    return observation;
  };

  const buildMeta = (observation, extraMeta = {}) => ({
    url: (observation && observation.url) || "",
    title: (observation && observation.title) || "",
    actionHistory: actionHistory.slice(-5),
    elements: (observation && observation.elements) || [],
    pageContext: (observation && observation.pageContext) || state.lastPageContext || "",
    lastSummary: state.lastSummary || "",
    lastAction: state.lastAction || null,
    lastStepNote: state.lastStepNote || "",
    userReply: pendingUserReply,
    ...extraMeta,
  });

  const callPlanner = async (observation, extraMeta = {}) => {
    const t0 = Date.now();
    const resp = await self.requestPlan({
      controllerPrompt: self.PLANNER_PROMPT || "",
      goalText: goalText || "",
      screenshotDataUrl: observation?.screenshotDataUrl || "",
      meta: buildMeta(observation, extraMeta),
    });
    metrics.plannerCalls += 1;
    metrics.plannerDurations.push(Date.now() - t0);
    logTiming("planner_call", t0, 300);
    try {
      const planArr = Array.isArray(resp?.plan) ? resp.plan : [];
      const stepIds = planArr.map((s) => s?.id || "?").join(", ");
      console.log("[agent][planner] plan received:", planArr.length, "steps ids:", stepIds);
    } catch (e) {
      console.warn("[agent][planner] plan logging failed:", e);
    }
    return resp;
  };

  const callExecutor = async (observation, step, extraMeta = {}) => {
    const t0 = Date.now();
    const decision = await self.requestExecuteStep({
      executorPrompt: self.EXECUTOR_PROMPT || "",
      goalText: goalText || "",
      step,
      meta: buildMeta(observation, extraMeta),
    });
    metrics.executorCalls += 1;
    metrics.executorDurations.push(Date.now() - t0);
    logTiming("executor_call", t0, 250);
    try {
      console.log(
        "[agent][planner] executor decision for",
        step?.id || "no-id",
        "action:",
        decision?.action,
        "conf:",
        decision?.confidence,
        "allowed:",
        Array.isArray(step?.allowed_actions) ? step.allowed_actions.join(",") : ""
      );
    } catch (e) {
      console.warn("[agent][planner] executor logging failed:", e);
    }
    return decision;
  };

  const verifyStep = async (step, observation) => {
    const verify = step && typeof step === "object" ? step.verify : null;
    if (!verify || typeof verify !== "object") {
      return { passed: true, observation, reason: "" };
    }

    let latestObservation = observation;
    if (verify.url_includes) {
      try {
        await waitForTabComplete(controlledTabId).catch(() => {});
      } catch (_) {}
      const tab = await getTabById(controlledTabId);
      const currentUrl = (tab && tab.url) || (latestObservation && latestObservation.url) || "";
      if (!currentUrl.includes(verify.url_includes)) {
        return { passed: false, observation: latestObservation, reason: `url missing "${verify.url_includes}"` };
      }
    }

    const includesAny = Array.isArray(verify.page_includes_any) ? verify.page_includes_any : [];
    const excludesAny = Array.isArray(verify.page_excludes_any) ? verify.page_excludes_any : [];
    const needsPageCheck = includesAny.length || excludesAny.length;
    if (needsPageCheck) {
      const refreshed = await recordObservation();
      if (refreshed) {
        latestObservation = refreshed;
      }
      const pageText = ((latestObservation && latestObservation.pageContext) || "").toLowerCase();
      if (includesAny.length) {
        const hasInclude = includesAny.some((frag) => pageText.includes((frag || "").toLowerCase()));
        if (!hasInclude) {
          return { passed: false, observation: latestObservation, reason: "page_includes_any not found" };
        }
      }
      if (excludesAny.length) {
        const hasExclude = excludesAny.some((frag) => pageText.includes((frag || "").toLowerCase()));
        if (hasExclude) {
          return { passed: false, observation: latestObservation, reason: "page_excludes_any present" };
        }
      }
    }

    return { passed: true, observation: latestObservation, reason: "" };
  };

  try {
    if (isCanceled()) return;
    lastObservation = await recordObservation();
    if (!lastObservation) {
      console.warn("[agent][planner] Initial observation failed; stopping");
      return;
    }
    if (isCanceled()) return;
    await notifyAgentUi(controlledTabId, true);

    let planResp;
    try {
      planResp = await callPlanner(lastObservation, { lastError });
    } catch (err) {
      console.error("[agent][planner] Planner call failed:", err);
      return;
    }
    if (isCanceled()) return;

    let plan = Array.isArray(planResp?.plan) ? planResp.plan : [];
    if (!plan.length) {
      console.warn("[agent][planner] Planner returned empty plan; stopping");
      return;
    }

    let planIndex = 0;
    while (planIndex < plan.length && metrics.stepsExecuted < MAX_STEPS) {
      if (isCanceled()) {
        console.log("[agent][planner] Run canceled; stopping");
        break;
      }
      const currentTab = await getTabById(controlledTabId);
      if (!currentTab) {
        console.warn("[agent][planner] Agent tab no longer exists; stopping");
        break;
      }

      if (isDisallowedUrl(currentTab.url)) {
        console.error("[agent][planner] Cannot run agent on chrome:// pages; stopping");
        break;
      }

      const step = plan[planIndex];
      planIndex += 1;

      lastObservation = await recordObservation();
      if (!lastObservation) {
        console.warn("[agent][planner] Observation failed; stopping");
        break;
      }
      if (isCanceled()) {
        console.log("[agent][planner] Run canceled after observation; stopping");
        break;
      }
      await notifyAgentUi(controlledTabId, true);

      let decision;
      try {
        decision = await callExecutor(lastObservation, step, { planStepId: step?.id || "" });
      } catch (err) {
        console.warn("[agent][planner] Executor call failed:", err);
        decision = null;
      }
      if (isCanceled()) {
        console.log("[agent][planner] Run canceled after executor; stopping");
        break;
      }

      let action = decision?.action;
      let value = decision?.value;
      let confidence = typeof decision?.confidence === "number" ? decision.confidence : 0;

      if (!decision || confidence < 0.55 || (action === "report_error" && value === "NEED_FALLBACK")) {
        metrics.fallbackCalls += 1;
        console.warn(
          "[agent][planner] low confidence or NEED_FALLBACK; using baseline. step:",
          step?.id || "no-id",
          "conf:",
          confidence,
          "action:",
          action
        );
        try {
          const fallbackDecision = await self.requestAgentStep({
            goalText,
            screenshotDataUrl: lastObservation.screenshotDataUrl || "",
            url: lastObservation.url || currentTab.url || "",
            title: lastObservation.title || currentTab.title || "",
            actionHistory: actionHistory.slice(-5),
            elements: lastObservation.elements || [],
            userReply: pendingUserReply,
            lastAction: state.lastAction || null,
            lastStepNote: state.lastStepNote || "",
          });
          action = fallbackDecision.action;
          value = fallbackDecision.value;
          confidence = 1;
        } catch (err) {
          console.error("[agent][planner] Fallback agent-step failed:", err);
          break;
        }
      }
      if (isCanceled()) {
        console.log("[agent][planner] Run canceled after fallback decision; stopping");
        break;
      }

      pendingUserReply = "";
      if (!action) {
        console.warn("[agent][planner] Missing action after executor/fallback; stopping");
        break;
      }

      console.log("[agent][planner] Step", metrics.stepsExecuted + 1, "-", step?.id || "no-id", "action:", action, "conf:", confidence);

      if (action === "done") {
        metrics.stepsExecuted += 1;
        break;
      }
      if (action === "report_error") {
        metrics.stepsExecuted += 1;
        console.warn("[agent][planner] report_error:", value);
        break;
      }

      if (action === "ask_user") {
        const auto = await autoAnswerAskUser(value || "");
        if (auto) {
          actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${auto.slice(0, 80)}`, true));
          updateLastAction(state, action, value, "user_reply_captured");
          updateLastStepNote(state, decision);
          pendingUserReply = auto;
          if (isCanceled()) {
            console.log("[agent][planner] Run canceled after auto-answer; stopping");
            break;
          }
          metrics.stepsExecuted += 1;
          continue;
        }
        const reply = await promptUser(value, controlledTabId);
        if (!reply) {
          console.warn("[agent][planner] No user reply; stopping");
          break;
        }
        if (isCanceled()) {
          console.log("[agent][planner] Run canceled after user reply; stopping");
          break;
        }
        actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${reply.slice(0, 80)}`, true));
        updateLastAction(state, action, value, "user_reply_captured");
        updateLastStepNote(state, decision);
        pendingUserReply = reply;
        metrics.stepsExecuted += 1;
        continue;
      }

    const execStart = Date.now();
    const executed = await executeAction(
      controlledTabId,
      action,
      value,
      actionHistory,
      lastObservation.elements || [],
      currentTab.url || "",
      state,
      lastObservation.frameId || 0
    );
    logTiming("executeAction_planner", execStart, 200);
      if (isCanceled()) {
        console.log("[agent][planner] Run canceled after action execution; stopping");
        break;
      }
      if (!executed || executed.ok !== true) {
        console.warn("[agent][planner] Action failed; stopping");
        break;
      }
      const followedTarget = await adoptAgentTab(controlledTabId, controlledWindowId, action, executed);
      controlledTabId = followedTarget.tabId;
      controlledWindowId = followedTarget.windowId;
      updateLastStepNote(state, decision);

      metrics.stepsExecuted += 1;
      lastError = "";

      const verifyResult = await verifyStep(step, lastObservation);
      if (isCanceled()) {
        console.log("[agent][planner] Run canceled after verification; stopping");
        break;
      }
      if (!verifyResult.passed) {
        lastError = verifyResult.reason;
        lastObservation = verifyResult.observation || lastObservation;
        console.warn("[agent][planner] Verification failed:", lastError);
        try {
          const replanResp = await callPlanner(lastObservation, {
            lastError: `${step?.id || "step"}: ${lastError}`,
            failedStep: step?.id || "",
          });
          plan = Array.isArray(replanResp?.plan) ? replanResp.plan : [];
          planIndex = 0;
          if (!plan.length) {
            console.warn("[agent][planner] Replan returned empty plan; stopping");
            break;
          }
          console.log("[agent][planner] Replan triggered; new plan length:", plan.length);
          continue;
        } catch (err) {
          console.error("[agent][planner] Replan failed:", err);
          break;
        }
      }
    }
  } finally {
    if (!isCanceled()) {
      await sendPlannerSummary(controlledTabId, metrics);
    }
  }
}

async function sendPlannerSummary(tabId, metrics) {
  if (!tabId || !metrics) return;
  const totalMs = Math.max(0, Date.now() - (metrics.startTime || Date.now()));
  const avg = (list) => {
    if (!Array.isArray(list) || !list.length) return 0;
    const sum = list.reduce((acc, cur) => acc + cur, 0);
    return Math.round(sum / list.length);
  };

  const summaryLines = [
    "mode: planner_executor",
    `total_ms: ${totalMs}`,
    `steps_executed: ${metrics.stepsExecuted || 0}`,
    `observe_calls: ${metrics.observeCalls || 0}`,
    `planner_calls: ${metrics.plannerCalls || 0}`,
    `executor_calls: ${metrics.executorCalls || 0}`,
    `fallback_calls: ${metrics.fallbackCalls || 0}`,
    `avg_planner_ms: ${avg(metrics.plannerDurations)}`,
    `avg_executor_ms: ${avg(metrics.executorDurations)}`,
  ];

  try {
    await sendMessageToTab(tabId, { type: "SHOW_SUMMARY", summary: summaryLines.join("\n") });
  } catch (err) {
    console.warn("[agent][planner] Failed to send summary:", err);
  }
}

async function observeTab({ tabId, windowId, url, title, waitMs = 10, frameId = 0 }) {
  let attempts = 0;
  while (attempts < 2) {
    try {
      const showResult = await sendMessageToTab(tabId, { type: MSG_TYPES.OBSERVE_SHOW }, frameId);
      if (!showResult || showResult.success === false) {
        console.warn("[agent] OBSERVE_SHOW failed:", showResult && showResult.error);
        attempts++;
        if (attempts >= 2) return null;
        await tryInjectContentScript(tabId);
        continue;
      }

      await sleep(waitMs);
      const screenshotDataUrl = await captureVisibleTab(windowId);

      const hideResult = await sendMessageToTab(tabId, { type: MSG_TYPES.OBSERVE_HIDE }, frameId);
      if (!hideResult || hideResult.success === false) {
        console.warn("[agent] OBSERVE_HIDE failed:", hideResult && hideResult.error);
        attempts++;
        if (attempts >= 2) return null;
        await tryInjectContentScript(tabId);
        continue;
      }

      console.log(
        "[agent] Observed tab with overlays; candidates:",
        showResult.count !== undefined ? showResult.count : "unknown"
      );

      return {
        screenshotDataUrl,
        url: url || "",
        title: title || "",
        elements: showResult.elements || [],
        pageContext: showResult.pageContext || "",
        selectionText: showResult.selectionText || "",
        focusedElement: showResult.focusedElement || null,
        frameId,
      };
    } catch (err) {
      attempts++;
      if (attempts >= 2) {
        console.error("[agent] Observation error:", err);
        return null;
      }
      await tryInjectContentScript(tabId);
    }
  }
  return null;
}

function updateLastAction(state, action, value, info) {
  if (!state || typeof action !== "string") return;
  state.lastAction = {
    action,
    value,
    info: info || "",
  };
}

function updateLastStepNote(state, decision) {
  if (!state || !decision) return;
  const stepNote = typeof decision.step_note === "string" ? decision.step_note.trim() : "";
  if (!stepNote) return;
  state.lastStepNote = stepNote;
}

async function executeAction(tabId, action, value, actionHistory, elements, currentUrl, state, frameId = 0) {
  try {
    if (action === "switch_tab") {
      await switchTabDirection(value);
      const activeTab = await getActiveTab();
      await waitForTabComplete(activeTab?.id || tabId).catch(() => {});
      actionHistory?.push(formatActionHistoryEntry(action, value, "switched tab", true));
      console.log("[agent] Switched tab:", value);
      updateLastAction(state, action, value, "switched tab");
      return { ok: true, info: "switched tab" };
    }

    if (action === "open_url") {
      await openUrlInTab(tabId, value);
      await waitForTabComplete(tabId);
      actionHistory?.push(formatActionHistoryEntry(action, value, "navigated", true));
      console.log("[agent] Navigated to URL:", value);
      updateLastAction(state, action, value, "navigated");
      return { ok: true, info: "navigated" };
    }

    if (action === "search") {
      const query = typeof value === "string" ? value : "";
      const searchUrl = query.includes(".")
        ? (query.startsWith("http") ? query : `https://${query}`)
        : `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      await openUrlInTab(tabId, searchUrl);
      await waitForTabComplete(tabId);
      actionHistory?.push(formatActionHistoryEntry(action, value, "searched", true));
      console.log("[agent] Searched:", query);
      updateLastAction(state, action, value, "searched");
      return { ok: true, info: "searched" };
    }

    if (["click_index", "type_text", "select_type", "scroll"].includes(action)) {
      const sourceTab = action === "click_index" ? await getTabById(tabId) : null;
      const sourceWindowId = sourceTab && sourceTab.windowId !== undefined ? sourceTab.windowId : null;
      let result;
      let attemptedRetry = false;
      while (true) {
        try {
          logSelectedElement(action, value, elements);
          result = await sendMessageToTab(tabId, { type: MSG_TYPES.EXEC_ACTION, action, value }, frameId);
        } catch (err) {
          const msg = err && err.message ? err.message.toLowerCase() : "";
          const needRetry =
            !attemptedRetry &&
            (msg.includes("receiving end does not exist") || msg.includes("could not establish connection"));
          if (needRetry) {
            attemptedRetry = true;
            console.warn("[agent] Content script missing; reinjecting and retrying action");
            await ensureContentScriptInjected(tabId).catch(() => {});
            continue;
          }
          console.warn("[agent] Content action failed:", err);
          return { ok: false, error: err && err.message ? err.message : "content_action_failed" };
        }

        if (!result || result.success === false) {
          const errStr = (result && result.error) || "";
          const lowerErr = errStr.toLowerCase();
          const needRetry =
            !attemptedRetry &&
            (lowerErr.includes("receiving end does not exist") || lowerErr.includes("could not establish connection"));
          if (needRetry) {
            attemptedRetry = true;
            console.warn("[agent] Content script missing (result); reinjecting and retrying action");
            await ensureContentScriptInjected(tabId).catch(() => {});
            continue;
          }
          console.warn("[agent] Content action failed:", result && result.error);
          return { ok: false, error: errStr || "content_action_failed" };
        }
        break;
      }
      actionHistory?.push(formatActionHistoryEntry(action, value, result.info, true));
      console.log("[agent] Content action success:", result.info || action);

      if (action === "click_index") {
        const desc = findElementDescriptor(elements, value);
        const needsPause = isDriveUrl(currentUrl) ? isMenuLikeDescriptor(desc) : isLikelyModalTrigger(desc);
        if (needsPause) await sleep(50);
      }
      if (action === "click_index" || action === "select_type" || action === "type_text") {
        await sleep(POST_ACTION_DELAY_MS);
      }
      let followedTab = null;
      if (action === "click_index" && typeof sourceWindowId === "number") {
        followedTab = await detectFollowedTab(tabId, sourceWindowId);
        if (followedTab) {
          console.log("[agent] Following click into tab:", followedTab.tabId, "window:", followedTab.windowId);
        }
      }
      updateLastAction(state, action, value, result.info || "");
      return {
        ok: true,
        info: result.info || "",
        followedTabId: followedTab?.tabId ?? null,
        followedWindowId: followedTab?.windowId ?? null,
      };
    }

    if (action === "ask_user") {
      const auto = await autoAnswerAskUser(value || "");
      if (auto) {
        actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${auto.slice(0, 80)}`, true));
        state.lastUserReply = auto;
        updateLastAction(state, action, value, "user_reply_captured");
        return { ok: true, info: "user_reply_captured" };
      }
      const reply = await promptUser(value, tabId);
      if (!reply) {
        console.warn("[agent] ask_user had no reply; stopping");
        return { ok: false, error: "user_no_reply" };
      }
      actionHistory?.push(formatActionHistoryEntry(action, value, `user_reply:${reply.slice(0, 80)}`, true));
      state.lastUserReply = reply;
      updateLastAction(state, action, value, "user_reply_captured");
      return { ok: true, info: "user_reply_captured" };
    }

    console.warn("[agent] Unsupported action:", action);
    return { ok: false, error: "unsupported_action" };
  } catch (err) {
    console.error("[agent] executeAction error:", err);
    return { ok: false, error: err && err.message ? err.message : "executeAction_error" };
  }
}

function formatActionHistoryEntry(action, value, info, success) {
  const status = success ? "success" : "fail";
  let valStr = "";
  if (action === "click_index") {
    valStr = `(${value})`;
  } else if (action === "select_type" && value && typeof value === "object") {
    const preview = typeof value.text === "string" ? value.text.slice(0, 40) : "";
    valStr = `(${value.index}, "${preview}")`;
  } else if (action === "type_text") {
    const preview = typeof value === "string" ? value.slice(0, 40) : "";
    valStr = `("${preview}")`;
  } else if (value !== undefined && value !== null) {
    valStr = `(${JSON.stringify(value)})`;
  }
  const infoPart = info ? `: ${info}` : "";
  return `${action}${valStr} -> ${status}${infoPart}`;
}


function getActiveTab() {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
        return;
      }
      const filtered = (tabs || []).filter(
        (t) => t && t.id && !isDisallowedUrl(t.url)
      );
      if (!filtered.length) {
        resolve(null);
        return;
      }
      filtered.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      resolve(filtered[0]);
    });
  });
}

async function getActiveTabInWindow(windowId) {
  const tabs = await queryTabs({ windowId, active: true });
  return Array.isArray(tabs) && tabs.length ? tabs[0] : null;
}


function isInjectableUrl(url = "") {
  return url.startsWith("http://") || url.startsWith("https://");
}

function getTabById(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        const err = chrome.runtime.lastError;
        if (err || !tab) {
          resolve(null);
        } else {
          resolve(tab);
        }
      });
    } catch (err) {
      resolve(null);
    }
  });
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.query(queryInfo, (tabs) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve(tabs || []);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function sendMessageToTab(tabId, payload, frameId = 0) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, payload, { frameId }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function getBestFrameId(tabId) {
  const fallback = 0;

  // Small delay to let the tab paint/focus settle, mirroring the reference flow.
  await sleep(150);

  const frames = await new Promise((resolve) => {
    try {
      chrome.webNavigation.getAllFrames({ tabId }, (fs) => {
        const err = chrome.runtime.lastError;
        if (err || !fs?.length) {
          resolve([{ frameId: 0, parentFrameId: -1, url: "" }]);
          return;
        }
        resolve(fs);
      });
    } catch (_) {
      resolve([{ frameId: 0, parentFrameId: -1, url: "" }]);
    }
  });

  const settled = await Promise.allSettled(
    frames.map((f) =>
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [f.frameId] },
        args: [f.frameId],
        func: (frameId) => {
          const vw = Math.max(1, window.innerWidth || 0);
          const vh = Math.max(1, window.innerHeight || 0);

          const safeNum = (x, d = 0) => {
            const n = Number(x);
            return Number.isFinite(n) ? n : d;
          };
          const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
          const isVisible = (el) => {
            if (!el) return false;
            const cs = getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || safeNum(cs.opacity, 1) === 0) return false;
            const r = el.getBoundingClientRect();
            if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return false;
            if (r.width < 3 || r.height < 3) return false;
            if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) return false;
            return true;
          };

          const modalSelectors =
            '[role="dialog"],[aria-modal="true"],dialog[open],.goog-modalpopup,.docs-dialog-container,.docs-material-dialog,.jfk-dialog,.jfk-modal-dialog,.docs-overlay-container,.docs-dialog,.modal-dialog';
          const modals = Array.from(document.querySelectorAll(modalSelectors)).filter(isVisible);

          const modalInfos = modals.map((el) => {
            const r = el.getBoundingClientRect();
            const areaRatio = (() => {
              const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
              const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
              return (w * h) / (vw * vh);
            })();
            const z = (() => {
              const zi = getComputedStyle(el).zIndex;
              const n = Number(zi);
              return Number.isFinite(n) ? n : 0;
            })();
            const pts = [
              { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 },
              { x: r.left + r.width * 0.25, y: r.top + r.height * 0.25 },
              { x: r.left + r.width * 0.75, y: r.top + r.height * 0.25 },
            ].map((p) => ({
              x: clamp(Math.floor(p.x), 0, vw - 1),
              y: clamp(Math.floor(p.y), 0, vh - 1),
            }));
            let hits = 0;
            for (const p of pts) {
              const topEl = document.elementFromPoint(p.x, p.y);
              if (topEl && (topEl === el || el.contains(topEl))) hits++;
            }
            const ae = document.activeElement || null;
            const aeInside = !!(ae && (ae === el || el.contains(ae)));
            return { areaRatio, z, hitCount: hits, strongTopmost: hits >= 2, aeInside };
          });

          modalInfos.sort(
            (a, b) =>
              (b.strongTopmost - a.strongTopmost) ||
              (b.hitCount - a.hitCount) ||
              (b.aeInside - a.aeInside) ||
              (b.z - a.z) ||
              (b.areaRatio - a.areaRatio)
          );
          const bestModal = modalInfos[0] || null;

          let parentFrameTopHits = 0;
          let parentProbeOk = false;
          try {
            if (window.top !== window && window.frameElement && window.parent?.document) {
              const fe = window.frameElement;
              const pr = fe.getBoundingClientRect();
              const pts = [
                { x: (pr.left + pr.right) / 2, y: (pr.top + pr.bottom) / 2 },
                { x: pr.left + pr.width * 0.25, y: pr.top + pr.height * 0.25 },
                { x: pr.left + pr.width * 0.75, y: pr.top + pr.height * 0.25 },
              ].map((p) => ({
                x: clamp(Math.floor(p.x), 0, Math.max(0, window.parent.innerWidth - 1)),
                y: clamp(Math.floor(p.y), 0, Math.max(0, window.parent.innerHeight - 1)),
              }));
              for (const p of pts) {
                const topElInParent = window.parent.document.elementFromPoint(p.x, p.y);
                if (topElInParent && (topElInParent === fe || fe.contains(topElInParent))) {
                  parentFrameTopHits++;
                }
              }
              parentProbeOk = true;
            }
          } catch (_) {
            parentProbeOk = false;
          }

          const hasFocus = document.hasFocus();

          let score = 0;
          if (hasFocus) score += 8000;
          score += parentFrameTopHits * 6000;
          if (bestModal) {
            score += 4000;
            score += (bestModal.hitCount || 0) * 2200;
            if (bestModal.strongTopmost) score += 1600;
            if (bestModal.aeInside) score += 2200;
            score += Math.round((bestModal.areaRatio || 0) * 1800);
            score += Math.min(1200, Math.max(0, bestModal.z || 0));
          }
          if (parentProbeOk && window.top !== window && parentFrameTopHits === 0) {
            score -= 9000;
          }
          if (frameId === 0) score += 50;

          return {
            frameId,
            score,
            hasFocus,
            modalCount: modals.length,
            hitCount: bestModal?.hitCount ?? 0,
            strongTopmost: !!bestModal?.strongTopmost,
            aeInside: !!bestModal?.aeInside,
            parentFrameTopHits,
            parentProbeOk,
          };
        },
      })
    )
  );

  const results = settled.map((s, idx) => {
    const f = frames[idx];
    if (s.status !== "fulfilled") {
      return { frameId: f?.frameId ?? fallback, score: -1, parentFrameId: f?.parentFrameId ?? -1, parentProbeOk: false, parentFrameTopHits: 0, modalCount: 0, hitCount: 0, strongTopmost: false, aeInside: false, hasFocus: false };
    }
    const r = s.value?.[0]?.result;
    if (!r) return { frameId: f?.frameId ?? fallback, score: -1, parentFrameId: f?.parentFrameId ?? -1, parentProbeOk: false, parentFrameTopHits: 0, modalCount: 0, hitCount: 0, strongTopmost: false, aeInside: false, hasFocus: false };
    return { ...r, parentFrameId: f?.parentFrameId ?? -1 };
  });

  results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const strong = results.filter((r) => {
    if ((r.score ?? -1) < 0) return false;
    const frontmostIframe = r.parentProbeOk === true && (r.parentFrameTopHits ?? 0) >= 2;
    const strongModal = r.strongTopmost === true || (r.hitCount ?? 0) >= 2 || r.aeInside === true;
    if ((r.parentFrameId ?? -1) !== -1 && r.frameId !== 0) {
      return frontmostIframe || (strongModal && r.hasFocus);
    }
    return strongModal;
  });

  const weak = results.filter((r) => (r.score ?? -1) >= 0 && ((r.modalCount ?? 0) > 0 || (r.hitCount ?? 0) > 0));

  const bestCandidate =
    (strong.length ? strong[0] : null) ||
    (weak.length ? weak[0] : null) ||
    results.find((r) => (r.score ?? -1) >= 0);

  return bestCandidate?.frameId ?? fallback;
}

function captureVisibleTab(windowId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.captureVisibleTab(windowId, { format: "png" }, (dataUrl) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        if (!dataUrl) {
          reject(new Error("No screenshot data returned"));
          return;
        }
        resolve(dataUrl);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function switchTabDirection(direction) {
  if (direction !== "next" && direction !== "prev") {
    throw new Error(`Invalid switch_tab direction: ${direction}`);
  }

  const tabs = await queryTabs({ currentWindow: true });
  if (!tabs.length) {
    throw new Error("No tabs available to switch");
  }

  const activeIndex = tabs.findIndex((tab) => tab.active);
  const delta = direction === "prev" ? -1 : 1;
  const target = tabs[(activeIndex + delta + tabs.length) % tabs.length];

  return new Promise((resolve, reject) => {
    chrome.tabs.update(target.id, { active: true }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve(true);
      }
    });
  });
}

function openUrlInTab(tabId, url) {
  if (!url) {
    return Promise.reject(new Error("open_url requires a URL"));
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(err);
      } else {
        resolve(true);
      }
    });
  });
}

function waitForTabComplete(tabId, timeoutMs = 12000, pollIntervalMs = 250) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      chrome.tabs.get(tabId, (tab) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }

        if (tab && tab.status === "complete") {
          resolve(true);
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          reject(new Error("Tab did not complete loading in time"));
          return;
        }

        setTimeout(check, pollIntervalMs);
      });
    };

    check();
  });
}

function isDisallowedUrl(url) {
  return typeof url === "string" && (url.startsWith("chrome://") || url.startsWith("chrome-extension://"));
}

function tryInjectContentScript(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript(
        { target: { tabId, allFrames: true }, files: ["content.js"] },
        () => resolve(true)
      );
    } catch (e) {
      resolve(false);
    }
  });
}

function findElementDescriptor(elements, idx) {
  if (!Array.isArray(elements)) return null;
  const n = Number(idx);
  return elements.find((el) => el && Number(el.index) === n) || null;
}

function logSelectedElement(action, value, elements) {
  if (action !== "click_index" && action !== "select_type") return;
  const index = action === "select_type" && value && typeof value === "object" ? value.index : value;
  const desc = findElementDescriptor(elements, index);
  if (!desc) return;
  console.log("[agent] Selected element", {
    action,
    index,
    accessibleName: typeof desc.accessibleName === "string" ? desc.accessibleName : "",
    innerText: typeof desc.innerText === "string" ? desc.innerText : "",
  });
}

function isMenuLikeDescriptor(desc) {
  if (!desc) return false;
  const role = (desc.role || "").toLowerCase();
  const name = ((desc.accessibleName || "") + " " + (desc.innerText || "")).toLowerCase();
  if (role.includes("menu")) return true;
  if (name.includes("new")) return true;
  if (name.includes("more")) return true;
  if (name.includes("⋮") || name.includes("…") || name.includes("⋯")) return true;
  return false;
}

function isDriveUrl(url) {
  return typeof url === "string" && url.includes("://drive.google.com/");
}

function isLikelyModalTrigger(desc) {
  if (!desc) return false;
  const role = (desc.role || "").toLowerCase();
  const text = (
    (desc.accessibleName || "") +
    " " +
    (desc.innerText || "") +
    " " +
    (desc.placeholder || "")
  ).toLowerCase();

  const roleMatch = ["button", "menu", "menuitem", "tab", "dialog"].some((r) => role.includes(r));
  const keywords = [
    "create",
    "new",
    "add",
    "start",
    "compose",
    "event",
    "meeting",
    "calendar",
    "appointment",
    "schedule",
    "task",
    "reminder",
    "edit",
    "options",
    "settings",
    "more",
    "menu",
    "dropdown",
    "open",
    "view",
    "details",
    "attach",
    "upload",
    "insert",
    "picker",
    "select",
    "choose",
    "save",
    "buy",
    "next",
    "continue",
    "confirm",
    "done",
    "finish",
    "login",
    "log in",
    "sign in",
    "sign up",
    "signup",
    "register",
    "continue with",
    "submit",
  ];
  const textMatch = keywords.some((k) => text.includes(k));
  return roleMatch || textMatch;
}

function promptUser(question, tabId) {
  return new Promise((resolve) => {
    try {
      pendingUserReplyResolver = resolve;
      chrome.tabs.sendMessage(
        tabId,
        { type: "SHOW_QUESTION", question },
        { frameId: 0 },
        () => {}
      );
      // Speak the question (fire and forget).
      speakText(question || "").then((audioUrl) => {
        if (audioUrl) {
          fireAndForgetTabMessage(tabId, { type: "PLAY_TTS", audioUrl }, 0);
        }
      }).catch(() => {});
      setTimeout(() => {
      if (pendingUserReplyResolver) {
        pendingUserReplyResolver("");
        pendingUserReplyResolver = null;
      }
    }, 45000);
  } catch (err) {
    resolve("");
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!manualOverlayMode) return;
  if (activeInfo.tabId !== manualOverlayTabId) {
    if (Date.now() <= manualOverlayFollowUntil) {
      return;
    }
    disableManualOverlayMode().catch(() => {});
    return;
  }
  scheduleManualOverlayRefreshCycle(activeInfo.tabId, [0, ...MANUAL_OVERLAY_REFRESH_SCHEDULE_MS]);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!isManualOverlayActiveForTab(tabId)) return;
  if (changeInfo.url || changeInfo.status === "complete" || tab?.status === "complete") {
    scheduleManualOverlayRefreshCycle(tabId);
  }
});
}

async function startAgentAtUrl(url, goalText, mode) {
  if (!url || typeof url !== "string") {
    console.error("[agent] START_AGENT_AT_URL requires a url");
    return;
  }

  if (isDisallowedUrl(url)) {
    console.error("[agent] Cannot run agent on chrome:// pages; switch to a normal website tab and restart");
    return;
  }

  if (isAgentRunning) {
    console.warn("[agent] Already running; ignoring START_AGENT_AT_URL");
    return;
  }

  let tab;
  try {
    tab = await createTab(url);
  } catch (err) {
    console.error("[agent] Failed to create tab:", err);
    return;
  }

  const tabId = tab.id;
  const windowId = tab.windowId;

  try {
    await waitForTabCompleteEvent(tabId);
  } catch (err) {
    console.error("[agent] Tab did not finish loading:", err);
    return;
  }

  const ready = await ensureContentScriptInjected(tabId);
  if (!ready) {
    console.error("[agent] Could not reach content script on tab", tabId);
    return;
  }

  startAgent(goalText, { tabId, windowId }, mode);
}

function createTab(url) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.create({ url }, (tab) => {
        const err = chrome.runtime.lastError;
        if (err || !tab) {
          reject(err || new Error("Failed to create tab"));
          return;
        }
        resolve(tab);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function waitForTabCompleteEvent(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timer;

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete" || tab?.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        if (timer) clearInterval(timer);
        resolve(true);
      }
    };

    chrome.tabs.get(tabId, (tab) => {
      const err = chrome.runtime.lastError;
      if (err || !tab) {
        reject(err || new Error("Tab not found"));
        return;
      }
      if (tab.status === "complete") {
        resolve(true);
        return;
      }
      chrome.tabs.onUpdated.addListener(listener);
      timer = setInterval(() => {
        if (Date.now() - start >= timeoutMs) {
          chrome.tabs.onUpdated.removeListener(listener);
          if (timer) clearInterval(timer);
          reject(new Error("Timed out waiting for tab load"));
        }
      }, 300);
    });
  });
}

async function ensureContentScriptInjected(tabId) {
  const pingOk = await pingContent(tabId);
  if (pingOk) return true;

  try {
    await injectContentScript(tabId);
  } catch (err) {
    console.error("[agent] Failed to inject content script:", err);
    return false;
  }

  return pingContent(tabId);
}

function pingContent(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "PING" }, { frameId: 0 }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve(false);
        return;
      }
      resolve(resp && resp.success === true);
    });
  });
}

function injectContentScript(tabId) {
  return chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ["content.js"],
  });
}
