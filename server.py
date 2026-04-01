import os, json, asyncio, base64, time
from typing import Any, Optional
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from openai import OpenAI
import websockets




client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
app = FastAPI()


PLANNER_MODEL = os.environ.get("PLANNER_MODEL", "gpt-4o")
EXECUTOR_MODEL = os.environ.get("EXECUTOR_MODEL", "gpt-4o-mini")
ORCHESTRATOR_MODEL = os.environ.get("ORCHESTRATOR_MODEL", "gpt-4o")
WORKER_MODEL = os.environ.get("WORKER_MODEL", "gpt-4o-mini")
PROFILE_MODEL = os.environ.get("PROFILE_MODEL", "gpt-4o-mini")
TTS_MODEL = os.environ.get("TTS_MODEL", "gpt-4o-mini-tts")
DEBUG_SERVER = os.environ.get("CORA_DEBUG", "0").lower() not in {"0", "false", "off"}
DEBUG_STRING_LIMIT = 500
DEBUG_ARRAY_LIMIT = 12




class AgentStep(BaseModel):
    controllerPrompt: str
    goalText: str
    screenshotDataUrl: str
    meta: dict




class PlanReq(BaseModel):
    controllerPrompt: str
    goalText: str
    screenshotDataUrl: str
    meta: dict




class ExecuteReq(BaseModel):
    executorPrompt: str
    goalText: str
    step: dict
    meta: dict


class OrchestratorReq(BaseModel):
    orchestratorPrompt: str
    operation: str
    goal: Optional[str] = None
    browserContext: Optional[dict[str, Any]] = None
    taskState: Optional[dict[str, Any]] = None
    userText: Optional[str] = None


class WorkerReq(BaseModel):
    workerPrompt: str
    workerInput: dict[str, Any]


class StatusReq(BaseModel):
    statusPrompt: str
    goalText: str
    screenshotDataUrl: str
    meta: dict




class SummarizeReq(BaseModel):
    question: str = "Summarize the page."
    screenshotDataUrl: str




class IntentReq(BaseModel):
    text: str


class ProfileAnswerReq(BaseModel):
    user_profile: dict
    question: str

class TTSReq(BaseModel):
    text: str
    voice: str = "marin"


def dump_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except Exception:
        return "{}"


def sanitize_debug_value(value: Any, key: str = "", depth: int = 0) -> Any:
    if depth > 5:
        return "[max_depth]"
    if isinstance(value, str):
        if key in {"screenshotDataUrl", "screenshot_data_url"}:
            return f"[data_url length={len(value)}]"
        if len(value) > DEBUG_STRING_LIMIT:
            return f"{value[:DEBUG_STRING_LIMIT]}...[truncated {len(value) - DEBUG_STRING_LIMIT} chars]"
        return value
    if isinstance(value, list):
        next_items = [sanitize_debug_value(item, key, depth + 1) for item in value[:DEBUG_ARRAY_LIMIT]]
        if len(value) > DEBUG_ARRAY_LIMIT:
            next_items.append(f"[{len(value) - DEBUG_ARRAY_LIMIT} more items]")
        return next_items
    if isinstance(value, dict):
        return {
            child_key: sanitize_debug_value(child_value, child_key, depth + 1)
            for child_key, child_value in value.items()
        }
    return value


def debug_print(label: str, payload: Any = None) -> None:
    if not DEBUG_SERVER:
        return
    if payload is None:
        print(f"[debug] {label}")
        return
    print(f"[debug] {label}: {dump_json(sanitize_debug_value(payload))}")


def info_print(message: str) -> None:
    if DEBUG_SERVER:
        print(message)


def timing_print(label: str, started_at: float) -> None:
    if DEBUG_SERVER:
        print(f"[timing] {label} openai_ms={int((time.monotonic() - started_at) * 1000)}")


def build_llm_error_detail(operation: str, model: str, error: Exception) -> dict[str, Any]:
    return {
        "operation": operation,
        "model": model,
        "error_type": type(error).__name__,
        "message": str(error),
    }


def build_multimodal_content(text: str, image_url: str = "") -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": text}]
    if isinstance(image_url, str) and image_url:
        content.append({"type": "image_url", "image_url": {"url": image_url}})
    return content


def call_json_completion(model: str, system_prompt: str, user_text: str, image_url: str = "") -> dict[str, Any]:
    json_system_prompt = (
        f"{system_prompt.rstrip()}\n\n"
        "Return valid json only. The response must be a single json object."
    )
    json_user_text = f"Return valid json only.\n\n{user_text}"
    resp = client.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": json_system_prompt},
            {"role": "user", "content": build_multimodal_content(json_user_text, image_url)},
        ],
    )
    return json.loads(resp.choices[0].message.content)



def format_history(meta):
    if isinstance(meta, dict):
        hist = meta.get("actionHistory")
        if isinstance(hist, list):
            return "\n".join(hist)
    return ""




def format_elements(meta, limit=120):
    if not isinstance(meta, dict):
        return ""
    elements = meta.get("elements")
    if not isinstance(elements, list):
        return ""
    lines = []
    for el in elements[:limit]:
        idx = el.get("index")
        role = el.get("role") or ""
        name = (el.get("accessibleName") or "").strip()
        text = (el.get("innerText") or "").strip()
        placeholder = (el.get("placeholder") or "").strip()
        region = el.get("region") or {}
        horiz = region.get("horizontal") or ""
        vert = region.get("vertical") or ""
        bbox = el.get("bbox") or {}
        line = (
            f"{idx} | role:{role} | name:{name[:60]} | text:{text[:60]} "
            f"| placeholder:{placeholder[:40]} | region:{vert}/{horiz} "
            f"| bbox:({bbox.get('x')},{bbox.get('y')},{bbox.get('w')},{bbox.get('h')})"
        )
        lines.append(line)
    return "\n".join(lines)


def format_trimmed_history(meta, limit=5):
    if not isinstance(meta, dict):
        return ""
    hist = meta.get("actionHistory")
    if not isinstance(hist, list):
        return ""
    return "\n".join([str(x) for x in hist[-limit:]])


def format_last_action(meta):
    if not isinstance(meta, dict):
        return ""
    last_action = meta.get("lastAction")
    if not isinstance(last_action, dict):
        return ""
    try:
        return json.dumps(last_action, ensure_ascii=False)
    except Exception:
        return ""


def format_last_step_note(meta):
    if not isinstance(meta, dict):
        return ""
    last_step_note = meta.get("lastStepNote")
    if isinstance(last_step_note, str):
        return last_step_note.strip()
    last_expectation = meta.get("lastExpectation")
    if isinstance(last_expectation, dict):
        why = str(last_expectation.get("why") or "").strip()
        expect_next = str(last_expectation.get("expect_next") or "").strip()
        return " ".join(part for part in [why, expect_next] if part)
    if isinstance(last_expectation, str):
        return last_expectation.strip()
    return ""




@app.post("/orchestrator")
def orchestrator(req: OrchestratorReq):
    operation = (req.operation or "").strip().lower()
    if operation not in {"initialize", "mutate"}:
        raise HTTPException(status_code=400, detail="operation must be initialize or mutate")

    if operation == "initialize" and not (req.goal or "").strip():
        raise HTTPException(status_code=400, detail="initialize requires goal")
    if operation == "mutate" and (not isinstance(req.taskState, dict) or not (req.userText or "").strip()):
        raise HTTPException(status_code=400, detail="mutate requires taskState and userText")

    browser_context = req.browserContext if isinstance(req.browserContext, dict) else {}

    if operation == "initialize":
        user_text = (
            "OPERATION: initialize\n\n"
            f"USER_GOAL:\n{req.goal or ''}\n\n"
            f"BROWSER_CONTEXT:\n{dump_json(browser_context)}"
        )
    else:
        user_text = (
            "OPERATION: mutate\n\n"
            f"USER_TEXT:\n{req.userText or ''}\n\n"
            f"CURRENT_TASK_STATE:\n{dump_json(req.taskState or {})}\n\n"
            f"BROWSER_CONTEXT:\n{dump_json(browser_context)}"
        )

    debug_print("orchestrator.request", {
        "operation": operation,
        "model": ORCHESTRATOR_MODEL,
        "goal": req.goal,
        "userText": req.userText,
        "browserContext": browser_context,
        "taskState": req.taskState,
    })

    try:
        t0 = time.monotonic()
        result = call_json_completion(
            model=ORCHESTRATOR_MODEL,
            system_prompt=req.orchestratorPrompt,
            user_text=user_text,
        )
        debug_print("orchestrator.response", result)
        timing_print("/orchestrator", t0)
        return result
    except Exception as e:
        info_print(f"LLM error: {e}")
        raise HTTPException(
            status_code=500,
            detail=build_llm_error_detail("orchestrator", ORCHESTRATOR_MODEL, e),
        )


@app.post("/worker")
def worker(req: WorkerReq):
    worker_input = req.workerInput if isinstance(req.workerInput, dict) else {}
    screenshot_data_url = worker_input.get("screenshot_data_url") or ""
    worker_text_input = dict(worker_input)
    if "screenshot_data_url" in worker_text_input:
        worker_text_input["screenshot_data_url"] = "<attached_image>" if screenshot_data_url else ""

    user_text = f"WORKER_INPUT:\n{dump_json(worker_text_input)}"
    debug_print("worker.request", {
        "model": WORKER_MODEL,
        "workerInput": req.workerInput,
    })

    try:
        t0 = time.monotonic()
        result = call_json_completion(
            model=WORKER_MODEL,
            system_prompt=req.workerPrompt,
            user_text=user_text,
            image_url=screenshot_data_url,
        )
        debug_print("worker.response", result)
        timing_print("/worker", t0)
        return result
    except Exception as e:
        info_print(f"LLM error: {e}")
        raise HTTPException(
            status_code=500,
            detail=build_llm_error_detail("worker", WORKER_MODEL, e),
        )


@app.post("/agent-step")
def agent_step(req: AgentStep):
    history_text = format_history(req.meta)
    elements_text = format_elements(req.meta)
    last_action_text = format_last_action(req.meta)
    last_step_note_text = format_last_step_note(req.meta)




    url = ""
    title = ""
    user_reply = ""
    page_context = ""
    last_summary = ""
    if isinstance(req.meta, dict):
        url = req.meta.get("url") or ""
        title = req.meta.get("title") or ""
        user_reply = req.meta.get("userReply") or ""
        page_context = req.meta.get("pageContext") or ""
        last_summary = req.meta.get("lastSummary") or ""




    rules_text = (
        "ELEMENTS RULE: Prefer matching by accessibleName / innerText / placeholder / role over visuals alone.\n"
        "ACTION_HISTORY RULE: Treat ACTION_HISTORY as completed steps; don’t repeat unless the UI changed or the last attempt failed.\n"
        "AMBIGUITY RULE: If multiple overlays could match, pick the single best visible match using nearby text/icon context. "
        "Use ask_user ONLY when there is no clear target or when required info is missing from the UI.\n"
        "ASK USER RULE: If any required value (names, emails, phone, address, etc.) is missing from the UI or USER_REPLY, "
        "do not guess. Immediately return {\"action\":\"ask_user\",\"value\":\"<concise question>\"}. Do NOT invent personal data.\n"
        "EMAIL RULE: Never fabricate an email. If not provided, ask_user.\n"
    )




    user_text = (
        f"{rules_text}\n"
        f"USER_GOAL:\n{req.goalText}\n\n"
        f"USER_REPLY:\n{user_reply}\n\n"
        f"LAST_SUMMARY:\n{last_summary}\n\n"
        f"PAGE_CONTEXT:\n{page_context}\n\n"
        f"URL:\n{url}\n\n"
        f"TITLE:\n{title}\n\n"
        f"ACTION_HISTORY:\n{history_text}\n\n"
        f"LAST_ACTION:\n{last_action_text}\n\n"
        f"LAST_STEP_NOTE:\n{last_step_note_text}\n\n"
        f"ELEMENTS:\n{elements_text}"
    )




    try:
        t0 = time.monotonic()
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": req.controllerPrompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": req.screenshotDataUrl}},
                    ],
                },
            ],
        )
        timing_print("/agent-step", t0)
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        info_print(f"LLM error: {e}")
        raise HTTPException(status_code=500, detail=str(e))




@app.post("/plan")
def plan(req: PlanReq):
    history_text = format_history(req.meta)
    elements_text = format_elements(req.meta)
    last_action_text = format_last_action(req.meta)
    last_step_note_text = format_last_step_note(req.meta)


    url = ""
    title = ""
    user_reply = ""
    page_context = ""
    last_summary = ""
    last_error = ""
    if isinstance(req.meta, dict):
        url = req.meta.get("url") or ""
        title = req.meta.get("title") or ""
        user_reply = req.meta.get("userReply") or ""
        page_context = req.meta.get("pageContext") or ""
        last_summary = req.meta.get("lastSummary") or ""
        last_error = req.meta.get("lastError") or ""


    user_text = (
        f"USER_GOAL:\n{req.goalText}\n\n"
        f"USER_REPLY:\n{user_reply}\n\n"
        f"LAST_SUMMARY:\n{last_summary}\n\n"
        f"PAGE_CONTEXT:\n{page_context}\n\n"
        f"URL:\n{url}\n\n"
        f"TITLE:\n{title}\n\n"
        f"ACTION_HISTORY:\n{history_text}\n\n"
        f"LAST_ACTION:\n{last_action_text}\n\n"
        f"LAST_STEP_NOTE:\n{last_step_note_text}\n\n"
        f"ELEMENTS:\n{elements_text}\n\n"
        f"NOTES:\n{last_error}"
    )


    try:
        t0 = time.monotonic()
        resp = client.chat.completions.create(
            model=PLANNER_MODEL,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": req.controllerPrompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": req.screenshotDataUrl}},
                    ],
                },
            ],
        )
        timing_print("/plan", t0)
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        info_print(f"LLM error: {e}")
        raise HTTPException(status_code=500, detail=str(e))




@app.post("/execute-step")
def execute_step(req: ExecuteReq):
    history_text = format_history(req.meta)
    elements_text = format_elements(req.meta)
    last_action_text = format_last_action(req.meta)
    last_step_note_text = format_last_step_note(req.meta)


    url = ""
    title = ""
    user_reply = ""
    page_context = ""
    last_summary = ""
    last_error = ""
    if isinstance(req.meta, dict):
        url = req.meta.get("url") or ""
        title = req.meta.get("title") or ""
        user_reply = req.meta.get("userReply") or ""
        page_context = req.meta.get("pageContext") or ""
        last_summary = req.meta.get("lastSummary") or ""
        last_error = req.meta.get("lastError") or ""


    step_text = json.dumps(req.step, ensure_ascii=False)


    user_text = (
        f"USER_GOAL:\n{req.goalText}\n\n"
        f"STEP:\n{step_text}\n\n"
        f"URL:\n{url}\n\n"
        f"TITLE:\n{title}\n\n"
        f"PAGE_CONTEXT:\n{page_context}\n\n"
        f"LAST_SUMMARY:\n{last_summary}\n\n"
        f"USER_REPLY:\n{user_reply}\n\n"
        f"ACTION_HISTORY:\n{history_text}\n\n"
        f"LAST_ACTION:\n{last_action_text}\n\n"
        f"LAST_STEP_NOTE:\n{last_step_note_text}\n\n"
        f"ELEMENTS:\n{elements_text}\n\n"
        f"NOTES:\n{last_error}"
    )


    try:
        t0 = time.monotonic()
        resp = client.chat.completions.create(
            model=EXECUTOR_MODEL,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": req.executorPrompt},
                {"role": "user", "content": [{"type": "text", "text": user_text}]},
            ],
        )
        timing_print("/execute-step", t0)
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        info_print(f"LLM error: {e}")
        raise HTTPException(status_code=500, detail=str(e))




@app.post("/summarize")
def summarize(req: SummarizeReq):
    try:
        t0 = time.monotonic()
        resp = client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "text"},
            messages=[
                {"role": "system", "content": (
                    "You are a helpful, confident assistant. Answer in 2–3 sentences, natural and conversational, "
                    "as if speaking aloud. If the user asked a question, answer it directly first. "
                    "Do NOT give bullet points or numbered steps. Be concise and avoid filler or rambling."
                )},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": req.question},
                        {"type": "image_url", "image_url": {"url": req.screenshotDataUrl}},
                    ],
                },
            ],
        )
        timing_print("/summarize", t0)
        return {"answer": resp.choices[0].message.content}
    except Exception as e:
        info_print(f"LLM error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



INTENT_SYSTEM = """
You are a router for simple browser commands. Return ONLY one JSON object: {"action": "...", "value": ...}
Allowed actions:
- show_overlays         (no value)
- hide_overlays         (no value)
- scroll                "up" | "up_small" | "down" | "down_small" | "top" | "bottom"
- click_index           integer
- switch_tab            "next" | "prev" | integer
- search                string
- open_url              string
Rules:
- JSON only. No prose. No code fences.
- Pick the single best action; no multi-step.
- “a little” → up_small/down_small; “all the way” → top/bottom.
- “tab 4” → switch_tab 4; “next tab”/“previous tab” → next/prev.
- “click/choose/select/press N” → click_index N.
- “google/search X” → search X. “open/go to <domain/url>” → open_url.
- If nothing matches, return {"action":"show_overlays","value":null}.
"""


@app.post("/intent")
def intent(req: IntentReq):
    try:
        t0 = time.monotonic()
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": INTENT_SYSTEM},
                {"role": "user", "content": req.text},
            ],
        )
        timing_print("/intent", t0)
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        info_print(f"LLM error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/status")
def status(req: StatusReq):
    url = ""
    title = ""
    page_context = ""
    elements_text = ""
    history_text = ""
    last_action_text = format_last_action(req.meta)
    last_step_note_text = format_last_step_note(req.meta)
    if isinstance(req.meta, dict):
        url = req.meta.get("url") or ""
        title = req.meta.get("title") or ""
        page_context = req.meta.get("pageContext") or ""
        elements_text = format_elements(req.meta, limit=40)
        history_text = format_trimmed_history(req.meta, limit=5)

    user_text = (
        f"USER_GOAL:\n{req.goalText}\n\n"
        f"URL:\n{url}\n\n"
        f"TITLE:\n{title}\n\n"
        f"PAGE_CONTEXT:\n{page_context}\n\n"
        f"ACTION_HISTORY:\n{history_text}\n\n"
        f"LAST_ACTION:\n{last_action_text}\n\n"
        f"LAST_STEP_NOTE:\n{last_step_note_text}\n\n"
        f"ELEMENTS:\n{elements_text}"
    )

    try:
        t0 = time.monotonic()
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": req.statusPrompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": req.screenshotDataUrl}},
                    ],
                },
            ],
        )
        timing_print("/status", t0)
        return json.loads(resp.choices[0].message.content)
    except Exception as e:
        info_print(f"LLM error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/profile-answer")
def profile_answer(req: ProfileAnswerReq):
    """
    Answer a profile-related question using only the supplied user_profile.
    Returns "UNKNOWN" when the requested info is not present.
    """
    try:
        t0 = time.monotonic()
        payload = json.dumps({"user_profile": req.user_profile, "question": req.question})
        resp = client.chat.completions.create(
            model=PROFILE_MODEL,
            response_format={"type": "text"},
            messages=[
                {"role": "system", "content": "Answer using only the provided user_profile. If the info is missing, reply EXACTLY UNKNOWN."},
                {"role": "user", "content": payload},
            ],
        )
        timing_print("/profile-answer", t0)
        answer = (resp.choices[0].message.content or "").strip()
        return {"answer": answer}
    except Exception as e:
        info_print(f"Profile answer error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/tts")
def tts(req: TTSReq):
    """
    Generate speech audio (mp3) from text using the configured TTS_MODEL voice (default "marin").
    Returns a data URL for convenient playback (non-streaming).
    """
    try:
        resp = client.audio.speech.create(
            model=TTS_MODEL,
            voice=req.voice or "marin",
            input=req.text or "",
        )
        audio_bytes = resp.read()
        b64 = base64.b64encode(audio_bytes).decode("ascii")
        return {"audio": f"data:audio/mp3;base64,{b64}"}
    except Exception as e:
        info_print(f"TTS error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



# -------- Realtime WebSocket relay (fixed) --------




OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription"
OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]


async def _connect_openai_ws(url: str):
    # websockets has had parameter name changes across versions.
    headers = [("Authorization", f"Bearer {OPENAI_API_KEY}")]
    try:
        return await websockets.connect(url, additional_headers=headers, ping_interval=20, ping_timeout=20)
    except TypeError:
        return await websockets.connect(url, extra_headers=headers, ping_interval=20, ping_timeout=20)








def _strict_base64_normalize(s: str) -> str:
    """
    Validates base64 and re-encodes it in a strict canonical form.
    Drops invalid chunks instead of forwarding bad data to OpenAI.
    """
    if not isinstance(s, str) or not s:
        return ""
    try:
        raw = base64.b64decode(s, validate=True)
    except Exception:
        return ""
    # PCM16 should be an even number of bytes; if not, trim last byte.
    if len(raw) % 2 == 1:
        raw = raw[:-1]
    return base64.b64encode(raw).decode("ascii")








def _extract_text_from_response_done(evt: dict) -> str:
    """
    response.done includes a 'response' with output items.
    We pull any output_text parts and join them.
    """
    resp = evt.get("response") or {}
    outs = resp.get("output") or []
    chunks = []
    for item in outs:
        content = item.get("content") or []
        for part in content:
            if part.get("type") == "output_text":
                t = part.get("text") or ""
                if t:
                    chunks.append(t)
    return "".join(chunks).strip()


@app.websocket("/ws/realtime")
async def realtime_proxy(ws: WebSocket):
    await ws.accept()


    try:
        openai_ws = await _connect_openai_ws(OPENAI_REALTIME_URL)
        await openai_ws.send(json.dumps({
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
            "input": {
                "format": {"type": "audio/pcm", "rate": 24000},
                "transcription": {"model": "gpt-4o-transcribe", "language": "en"},
                "turn_detection": {
                    "type": "server_vad",
                    "silence_duration_ms": 1300,
                    "threshold": 0.5
                },
            }
            }
        }
        }))




        info_print("[ws] connected to OpenAI Realtime")
    except Exception as e:
        await ws.send_json({"type": "error", "message": f"failed to connect/configure OpenAI: {e}"})
        try: await ws.close()
        except Exception: pass
        return


    partial_accum = ""


    async def client_to_openai():
        try:
            async for message in ws.iter_text():
                try:
                    msg = json.loads(message)
                except Exception:
                    continue
                mtype = msg.get("type")


                if mtype == "start":
                    await openai_ws.send(json.dumps({"type": "input_audio_buffer.clear"}))
                    continue


                if mtype == "audio":
                    audio_b64 = msg.get("data", "")
                    norm = _strict_base64_normalize(audio_b64)
                    if not norm:
                        continue
                    await openai_ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": norm,
                    }))
                    continue

                if mtype == "stop":
                    await openai_ws.send(json.dumps({"type": "input_audio_buffer.commit"}))
                    continue


        except WebSocketDisconnect:
            info_print("[ws] client disconnected")
        except Exception as e:
            info_print(f"[ws] client_to_openai error: {e}")


    async def openai_to_client():
        nonlocal partial_accum
        try:
            async for message in openai_ws:
                try:
                    evt = json.loads(message)
                except Exception:
                    continue


                etype = evt.get("type", "")


                if etype == "conversation.item.input_audio_transcription.delta":
                    delta = evt.get("delta", "") or ""
                    if delta:
                        await ws.send_json({"type": "partial", "text": delta})
                    continue


                if etype == "conversation.item.input_audio_transcription.completed":
                    final_text = evt.get("transcript", "") or ""
                    await ws.send_json({"type": "final", "text": final_text})
                    continue


                if etype == "error":
                    err = evt.get("error", {}) or {}
                    try:
                        info_print(f"[ws] openai error: {err.get('message', 'OpenAI error')}")
                    except Exception:
                        pass
                    try:
                        await ws.send_json({"type": "error", "message": err.get("message", "OpenAI error")})
                    except Exception:
                        pass
                    continue


        except Exception as e:
            info_print(f"[ws] openai_to_client error: {e}")


    t1 = asyncio.create_task(client_to_openai())
    t2 = asyncio.create_task(openai_to_client())
    done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()


    try: await openai_ws.close()
    except Exception: pass
    try: await ws.close()
    except Exception: pass
    info_print("[ws] closed")



