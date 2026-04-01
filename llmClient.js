// llmClient.js (classic script loaded via importScripts)
const API_BASE = "http://localhost:8000";
const AGENT_STEP_ENDPOINT = `${API_BASE}/agent-step`;
const PLAN_ENDPOINT = `${API_BASE}/plan`;
const EXECUTE_STEP_ENDPOINT = `${API_BASE}/execute-step`;
const STATUS_ENDPOINT = `${API_BASE}/status`;
const ORCHESTRATOR_ENDPOINT = `${API_BASE}/orchestrator`;
const WORKER_ENDPOINT = `${API_BASE}/worker`;

const ALLOWED_ACTIONS = new Set([
  "click_index",
  "type_text",
  "select_type",
  "scroll",
  "switch_tab",
  "open_url",
  "search",
  "done",
  "report_error",
  "ask_user"
]);
const ALLOWED_SCROLL_VALUES = new Set([
  "down_small",
  "down",
  "up_small",
  "up",
  "top",
  "bottom"
]);
const TASK_STATUS_VALUES = new Set([
  "idle",
  "running",
  "paused",
  "waiting_user",
  "completed",
  "failed"
]);
const SUBGOAL_STATUS_VALUES = new Set(["pending", "completed", "failed"]);
const ENTITY_TYPE_VALUES = new Set([
  "item",
  "source",
  "link",
  "contact",
  "event",
  "tab_hint",
  "form_field",
  "meeting_details",
  "other"
]);
const WORKER_VERIFICATION_VALUES = new Set(["passed", "failed", "uncertain"]);
const NEEDS_USER_KEYS = ["question", "slot", "choices"];
const MEMORY_PATCH_KEYS = [
  "scratchpad_set",
  "scratchpad_append",
  "entity_add",
  "entity_update",
  "entity_remove"
];
const TASK_STATE_KEYS = [
  "task_id",
  "goal",
  "state_revision",
  "active_subgoal_id",
  "change_log",
  "task_status",
  "subgoal_queue",
  "memory",
  "last_step",
  "history",
  "pending_question",
  "error"
];
const ORCHESTRATOR_MUTATION_KEYS = [
  "goal",
  "active_subgoal_id",
  "subgoal_queue",
  "pending_question",
  "error"
];
const WORKER_OUTPUT_KEYS = [
  "state_revision",
  "verification",
  "issue",
  "corrective_action",
  "action",
  "summary",
  "memory_patch",
  "subgoal_done",
  "needs_user"
];
const TASK_STATE_DISALLOWED_ACTIONS = new Set(["type_text"]);

function isInteger(value) {
  return Number.isInteger(value);
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(obj, allowedKeys, label) {
  if (!isPlainObject(obj)) {
    throw new Error(`${label} must be an object`);
  }
  const actualKeys = Object.keys(obj).sort();
  const expectedKeys = [...allowedKeys].sort();
  if (actualKeys.length !== expectedKeys.length) {
    throw new Error(`${label} has unexpected keys`);
  }
  for (let i = 0; i < expectedKeys.length; i++) {
    if (actualKeys[i] !== expectedKeys[i]) {
      throw new Error(`${label} has unexpected keys`);
    }
  }
}

function validateActionPayload(action, value) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`Invalid action "${action}" from LLM`);
  }

  switch (action) {
    case "click_index":
      if (!isInteger(value)) {
        throw new Error("click_index value must be an integer");
      }
      break;
    case "type_text":
      if (typeof value !== "string") {
        throw new Error("type_text value must be a string");
      }
      break;
    case "select_type":
      if (
        !value ||
        typeof value !== "object" ||
        !isInteger(value.index) ||
        typeof value.text !== "string"
      ) {
        throw new Error("select_type value must be { index: integer, text: string }");
      }
      break;
    case "scroll":
      if (!ALLOWED_SCROLL_VALUES.has(value)) {
        throw new Error("scroll value must be one of the allowed enums");
      }
      break;
    case "switch_tab":
      if (value !== "next" && value !== "prev") {
        throw new Error('switch_tab value must be "next" or "prev"');
      }
      break;
    case "open_url":
      if (typeof value !== "string") {
        throw new Error("open_url value must be a string URL");
      }
      break;
    case "search":
      if (typeof value !== "string") {
        throw new Error("search value must be a string query");
      }
      break;
    case "done":
      if (value !== null) {
        throw new Error("done value must be null");
      }
      break;
    case "report_error":
      if (typeof value !== "string") {
        throw new Error("report_error value must be a string");
      }
      break;
    case "ask_user":
      if (typeof value !== "string") {
        throw new Error("ask_user value must be a string question");
      }
      break;
    default:
      throw new Error(`Unhandled action "${action}"`);
  }
}

function validateTaskStateWorkerActionPayload(action, value, label) {
  if (TASK_STATE_DISALLOWED_ACTIONS.has(action)) {
    throw new Error(`${label} type_text is disabled for the task-state worker; use select_type instead`);
  }
  validateActionPayload(action, value);
}

function validateNeedsUser(payload, label = "needs_user") {
  if (payload === null) return null;
  assertExactKeys(payload, NEEDS_USER_KEYS, label);
  if (typeof payload.question !== "string" || !payload.question.trim()) {
    throw new Error(`${label}.question must be a non-empty string`);
  }
  if (typeof payload.slot !== "string" || !payload.slot.trim()) {
    throw new Error(`${label}.slot must be a non-empty string`);
  }
  if (!Array.isArray(payload.choices) || !payload.choices.every((item) => typeof item === "string")) {
    throw new Error(`${label}.choices must be an array of strings`);
  }
  return {
    question: payload.question.trim(),
    slot: payload.slot.trim(),
    choices: payload.choices.map((item) => item.trim()).filter(Boolean),
  };
}

function validateEntity(entity, label = "entity") {
  if (!isPlainObject(entity)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(entity).sort();
  const expected = ["data", "entity_id", "type"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has unexpected keys`);
  }
  if (typeof entity.entity_id !== "string" || !entity.entity_id.trim()) {
    throw new Error(`${label}.entity_id must be a non-empty string`);
  }
  if (!ENTITY_TYPE_VALUES.has(entity.type)) {
    throw new Error(`${label}.type is invalid`);
  }
  if (!isPlainObject(entity.data)) {
    throw new Error(`${label}.data must be an object`);
  }
  return {
    entity_id: entity.entity_id.trim(),
    type: entity.type,
    data: entity.data,
  };
}

function validateMemory(memory) {
  assertExactKeys(memory, ["scratchpad", "entities"], "memory");
  if (typeof memory.scratchpad !== "string") {
    throw new Error("memory.scratchpad must be a string");
  }
  if (!Array.isArray(memory.entities)) {
    throw new Error("memory.entities must be an array");
  }
  return {
    scratchpad: memory.scratchpad,
    entities: memory.entities.map((entity, index) => validateEntity(entity, `memory.entities[${index}]`)),
  };
}

function validateMemoryPatch(memoryPatch) {
  assertExactKeys(memoryPatch, MEMORY_PATCH_KEYS, "memory_patch");
  if (memoryPatch.scratchpad_set !== null && typeof memoryPatch.scratchpad_set !== "string") {
    throw new Error("memory_patch.scratchpad_set must be a string or null");
  }
  if (memoryPatch.scratchpad_append !== null && typeof memoryPatch.scratchpad_append !== "string") {
    throw new Error("memory_patch.scratchpad_append must be a string or null");
  }
  if (!Array.isArray(memoryPatch.entity_add)) {
    throw new Error("memory_patch.entity_add must be an array");
  }
  if (!Array.isArray(memoryPatch.entity_update)) {
    throw new Error("memory_patch.entity_update must be an array");
  }
  if (!Array.isArray(memoryPatch.entity_remove)) {
    throw new Error("memory_patch.entity_remove must be an array");
  }

  const entityAdd = memoryPatch.entity_add.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`memory_patch.entity_add[${index}] must be an object`);
    }
    assertExactKeys(item, ["type", "data"], `memory_patch.entity_add[${index}]`);
    if (!ENTITY_TYPE_VALUES.has(item.type)) {
      throw new Error(`memory_patch.entity_add[${index}].type is invalid`);
    }
    if (!isPlainObject(item.data)) {
      throw new Error(`memory_patch.entity_add[${index}].data must be an object`);
    }
    return { type: item.type, data: item.data };
  });

  const entityUpdate = memoryPatch.entity_update.map((item, index) => {
    if (!isPlainObject(item)) {
      throw new Error(`memory_patch.entity_update[${index}] must be an object`);
    }
    assertExactKeys(item, ["entity_id", "data_patch"], `memory_patch.entity_update[${index}]`);
    if (typeof item.entity_id !== "string" || !item.entity_id.trim()) {
      throw new Error(`memory_patch.entity_update[${index}].entity_id must be a non-empty string`);
    }
    if (!isPlainObject(item.data_patch)) {
      throw new Error(`memory_patch.entity_update[${index}].data_patch must be an object`);
    }
    return {
      entity_id: item.entity_id.trim(),
      data_patch: item.data_patch,
    };
  });

  const entityRemove = memoryPatch.entity_remove.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`memory_patch.entity_remove[${index}] must be a non-empty string`);
    }
    return item.trim();
  });

  return {
    scratchpad_set: memoryPatch.scratchpad_set,
    scratchpad_append: memoryPatch.scratchpad_append,
    entity_add: entityAdd,
    entity_update: entityUpdate,
    entity_remove: entityRemove,
  };
}

function validateSubgoal(subgoal, label = "subgoal") {
  assertExactKeys(subgoal, ["id", "objective", "status"], label);
  if (typeof subgoal.id !== "string" || !subgoal.id.trim()) {
    throw new Error(`${label}.id must be a non-empty string`);
  }
  if (typeof subgoal.objective !== "string" || !subgoal.objective.trim()) {
    throw new Error(`${label}.objective must be a non-empty string`);
  }
  if (!SUBGOAL_STATUS_VALUES.has(subgoal.status)) {
    throw new Error(`${label}.status is invalid`);
  }
  return {
    id: subgoal.id.trim(),
    objective: subgoal.objective.trim(),
    status: subgoal.status,
  };
}

function validateChangeLogEntry(entry, label = "change_log") {
  assertExactKeys(entry, ["revision", "user_text", "target_subgoal_id"], label);
  if (!isInteger(entry.revision) || entry.revision < 0) {
    throw new Error(`${label}.revision must be a non-negative integer`);
  }
  if (typeof entry.user_text !== "string") {
    throw new Error(`${label}.user_text must be a string`);
  }
  if (typeof entry.target_subgoal_id !== "string" || !entry.target_subgoal_id.trim()) {
    throw new Error(`${label}.target_subgoal_id must be a non-empty string`);
  }
  return {
    revision: entry.revision,
    user_text: entry.user_text,
    target_subgoal_id: entry.target_subgoal_id.trim(),
  };
}

function validateLastStep(lastStep) {
  assertExactKeys(lastStep, ["action", "summary", "timestamp", "result"], "last_step");
  if (lastStep.action !== null) {
    if (!isPlainObject(lastStep.action)) {
      throw new Error("last_step.action must be null or an object");
    }
    assertExactKeys(lastStep.action, ["type", "value"], "last_step.action");
    validateActionPayload(lastStep.action.type, lastStep.action.value);
  }
  if (typeof lastStep.summary !== "string") {
    throw new Error("last_step.summary must be a string");
  }
  if (lastStep.timestamp !== null && typeof lastStep.timestamp !== "string") {
    throw new Error("last_step.timestamp must be a string or null");
  }
  if (lastStep.result !== null && !isPlainObject(lastStep.result)) {
    throw new Error("last_step.result must be an object or null");
  }
  return {
    action: lastStep.action
      ? { type: lastStep.action.type, value: lastStep.action.value }
      : null,
    summary: lastStep.summary,
    timestamp: lastStep.timestamp,
    result: lastStep.result,
  };
}

function validateTaskState(taskState) {
  assertExactKeys(taskState, TASK_STATE_KEYS, "taskState");
  if (typeof taskState.task_id !== "string" || !taskState.task_id.trim()) {
    throw new Error("taskState.task_id must be a non-empty string");
  }
  if (typeof taskState.goal !== "string" || !taskState.goal.trim()) {
    throw new Error("taskState.goal must be a non-empty string");
  }
  if (!isInteger(taskState.state_revision) || taskState.state_revision < 0) {
    throw new Error("taskState.state_revision must be a non-negative integer");
  }
  if (typeof taskState.active_subgoal_id !== "string" || !taskState.active_subgoal_id.trim()) {
    throw new Error("taskState.active_subgoal_id must be a non-empty string");
  }
  if (!Array.isArray(taskState.change_log)) {
    throw new Error("taskState.change_log must be an array");
  }
  if (!TASK_STATUS_VALUES.has(taskState.task_status)) {
    throw new Error("taskState.task_status is invalid");
  }
  if (!Array.isArray(taskState.subgoal_queue) || !taskState.subgoal_queue.length) {
    throw new Error("taskState.subgoal_queue must be a non-empty array");
  }
  if (!Array.isArray(taskState.history) || !taskState.history.every((item) => typeof item === "string")) {
    throw new Error("taskState.history must be an array of strings");
  }
  if (taskState.error !== null && typeof taskState.error !== "string") {
    throw new Error("taskState.error must be a string or null");
  }

  const subgoalQueue = taskState.subgoal_queue.map((item, index) => validateSubgoal(item, `taskState.subgoal_queue[${index}]`));
  if (!subgoalQueue.some((item) => item.id === taskState.active_subgoal_id)) {
    throw new Error("taskState.active_subgoal_id must exist in subgoal_queue");
  }

  const validated = {
    task_id: taskState.task_id.trim(),
    goal: taskState.goal,
    state_revision: taskState.state_revision,
    active_subgoal_id: taskState.active_subgoal_id.trim(),
    change_log: taskState.change_log.map((item, index) => validateChangeLogEntry(item, `taskState.change_log[${index}]`)),
    task_status: taskState.task_status,
    subgoal_queue: subgoalQueue,
    memory: validateMemory(taskState.memory),
    last_step: validateLastStep(taskState.last_step),
    history: taskState.history.slice(),
    pending_question: validateNeedsUser(taskState.pending_question, "taskState.pending_question"),
    error: taskState.error,
  };

  if (validated.state_revision !== 0) {
    throw new Error("Initialized taskState.state_revision must be 0");
  }
  if (validated.task_status !== "running") {
    throw new Error('Initialized taskState.task_status must be "running"');
  }
  if (validated.memory.scratchpad !== "" || validated.memory.entities.length !== 0) {
    throw new Error("Initialized taskState.memory must be empty");
  }

  return validated;
}

function validateOrchestratorMutation(data) {
  assertExactKeys(data, ORCHESTRATOR_MUTATION_KEYS, "orchestrator mutation");
  if (typeof data.goal !== "string" || !data.goal.trim()) {
    throw new Error("orchestrator mutation.goal must be a non-empty string");
  }
  if (typeof data.active_subgoal_id !== "string" || !data.active_subgoal_id.trim()) {
    throw new Error("orchestrator mutation.active_subgoal_id must be a non-empty string");
  }
  if (!Array.isArray(data.subgoal_queue) || !data.subgoal_queue.length) {
    throw new Error("orchestrator mutation.subgoal_queue must be a non-empty array");
  }
  const subgoalQueue = data.subgoal_queue.map((item, index) => validateSubgoal(item, `orchestrator mutation.subgoal_queue[${index}]`));
  if (!subgoalQueue.some((item) => item.id === data.active_subgoal_id)) {
    throw new Error("orchestrator mutation.active_subgoal_id must exist in subgoal_queue");
  }
  if (data.error !== null && typeof data.error !== "string") {
    throw new Error("orchestrator mutation.error must be a string or null");
  }
  return {
    goal: data.goal,
    active_subgoal_id: data.active_subgoal_id.trim(),
    subgoal_queue: subgoalQueue,
    pending_question: validateNeedsUser(data.pending_question, "orchestrator mutation.pending_question"),
    error: data.error,
  };
}

function validateWorkerOutput(data, expectedRevision = null) {
  assertExactKeys(data, WORKER_OUTPUT_KEYS, "worker output");
  if (!isInteger(data.state_revision) || data.state_revision < 0) {
    throw new Error("worker output.state_revision must be a non-negative integer");
  }
  if (expectedRevision !== null && data.state_revision !== expectedRevision) {
    throw new Error("worker output.state_revision does not match input revision");
  }
  if (!WORKER_VERIFICATION_VALUES.has(data.verification)) {
    throw new Error("worker output.verification is invalid");
  }
  if (data.issue !== null && typeof data.issue !== "string") {
    throw new Error("worker output.issue must be a string or null");
  }
  if (data.corrective_action !== null) {
    if (!isPlainObject(data.corrective_action)) {
      throw new Error("worker output.corrective_action must be an object or null");
    }
    assertExactKeys(data.corrective_action, ["type", "value"], "worker output.corrective_action");
    validateTaskStateWorkerActionPayload(
      data.corrective_action.type,
      data.corrective_action.value,
      "worker output.corrective_action"
    );
  }
  if (!isPlainObject(data.action)) {
    throw new Error("worker output.action must be an object");
  }
  assertExactKeys(data.action, ["type", "value"], "worker output.action");
  validateTaskStateWorkerActionPayload(data.action.type, data.action.value, "worker output.action");
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    throw new Error("worker output.summary must be a non-empty string");
  }
  if (typeof data.subgoal_done !== "boolean") {
    throw new Error("worker output.subgoal_done must be a boolean");
  }

  const memoryPatch = validateMemoryPatch(data.memory_patch);
  const needsUser = validateNeedsUser(data.needs_user, "worker output.needs_user");
  if (needsUser) {
    if (data.action.type !== "ask_user") {
      throw new Error('worker output.needs_user requires action.type "ask_user"');
    }
    if (data.action.value !== needsUser.question) {
      throw new Error("worker output.action.value must match needs_user.question");
    }
  }

  return {
    state_revision: data.state_revision,
    verification: data.verification,
    issue: data.issue,
    corrective_action: data.corrective_action
      ? { type: data.corrective_action.type, value: data.corrective_action.value }
      : null,
    action: { type: data.action.type, value: data.action.value },
    summary: data.summary.trim(),
    memory_patch: memoryPatch,
    subgoal_done: data.subgoal_done,
    needs_user: needsUser,
  };
}

async function postJson(url, body) {
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new Error(`LLM request failed: ${err && err.message ? err.message : err}`);
  }

  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      if (typeof data?.detail === "string") {
        detail = data.detail;
      } else if (data?.detail && typeof data.detail === "object") {
        const message = typeof data.detail.message === "string" ? data.detail.message : "";
        const operation = typeof data.detail.operation === "string" ? data.detail.operation : "";
        const model = typeof data.detail.model === "string" ? data.detail.model : "";
        const errorType = typeof data.detail.error_type === "string" ? data.detail.error_type : "";
        const parts = [operation, model, errorType, message].filter(Boolean);
        detail = parts.join(" | ");
      } else if (data && typeof data === "object") {
        detail = JSON.stringify(data);
      }
    } catch (_) {
      try {
        detail = (await response.text()).trim();
      } catch (_) {
        detail = "";
      }
    }
    throw new Error(detail ? `LLM HTTP error: ${response.status} - ${detail}` : `LLM HTTP error: ${response.status}`);
  }

  try {
    return await response.json();
  } catch (err) {
    throw new Error("Failed to parse LLM JSON response");
  }
}

self.validateTaskState = validateTaskState;
self.validateOrchestratorMutation = validateOrchestratorMutation;
self.validateWorkerOutput = validateWorkerOutput;
self.validateMemoryPatch = validateMemoryPatch;
self.validateNeedsUser = validateNeedsUser;

self.requestAgentStep = async function requestAgentStep({
  goalText,
  screenshotDataUrl,
  url,
  title,
  actionHistory,
  elements,
  userReply,
  pageContext,
  lastSummary,
  lastAction,
  lastStepNote,
  lastError,
  userProfile
}) {
  const payload = {
    controllerPrompt: self.CONTROLLER_PROMPT,
    goalText: goalText || "",
    screenshotDataUrl: screenshotDataUrl || "",
    meta: {
      url: url || "",
      title: title || "",
      actionHistory: Array.isArray(actionHistory) ? actionHistory : [],
      elements: Array.isArray(elements) ? elements : [],
      userReply: userReply || "",
      pageContext: pageContext || "",
      lastSummary: lastSummary || "",
      lastAction: lastAction || null,
      lastStepNote: lastStepNote || "",
      lastError: lastError || "",
      userProfile: userProfile || null
    }
  };

  const data = await postJson(AGENT_STEP_ENDPOINT, payload);
  if (!data || typeof data.action !== "string") {
    throw new Error("LLM response missing required action");
  }
  validateActionPayload(data.action, data.value);
  return {
    action: data.action,
    value: data.value,
    step_note: typeof data.step_note === "string" ? data.step_note : ""
  };
};

self.requestPlan = async function requestPlan(payload) {
  const data = await postJson(PLAN_ENDPOINT, payload);
  if (!data || !Array.isArray(data.plan)) {
    throw new Error("Planner response missing plan array");
  }
  return data;
};

self.requestExecuteStep = async function requestExecuteStep(payload) {
  const data = await postJson(EXECUTE_STEP_ENDPOINT, payload);
  if (!data || typeof data.action !== "string") {
    throw new Error("Executor response missing required action");
  }
  if (typeof data.confidence !== "number" || Number.isNaN(data.confidence)) {
    throw new Error("Executor response missing numeric confidence");
  }
  validateActionPayload(data.action, data.value);
  return {
    action: data.action,
    value: data.value,
    confidence: data.confidence,
    rationale: data.rationale
  };
};

self.requestStatus = async function requestStatus(payload) {
  const data = await postJson(STATUS_ENDPOINT, payload);
  if (!data || typeof data.status !== "string") {
    throw new Error("Status response missing status");
  }
  const status = data.status;
  if (status !== "done" && status !== "not_done") {
    throw new Error("Status response has invalid status");
  }
  return {
    status,
    missing: typeof data.missing === "string" ? data.missing : ""
  };
};

self.requestOrchestrator = async function requestOrchestrator(payload) {
  const data = await postJson(ORCHESTRATOR_ENDPOINT, payload);
  if (payload?.operation === "initialize") {
    return validateTaskState(data);
  }
  if (payload?.operation === "mutate") {
    return validateOrchestratorMutation(data);
  }
  throw new Error("Invalid orchestrator operation");
};

self.requestWorkerStep = async function requestWorkerStep(payload) {
  const data = await postJson(WORKER_ENDPOINT, payload);
  const expectedRevision = payload?.workerInput?.state_revision;
  return validateWorkerOutput(data, typeof expectedRevision === "number" ? expectedRevision : null);
};

// Legacy export name preserved for existing callers.
self.getNextAction = self.requestAgentStep;
