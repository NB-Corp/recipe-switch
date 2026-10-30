"""Behavior recipe plugin, managed by recipe-switch."""
import json
import os
import uuid
import warnings
from datetime import datetime, timezone
from importlib.metadata import version as distribution_version, PackageNotFoundError
from pathlib import Path
from threading import Lock

_ROOT = Path(__file__).resolve().parent
_SNAPSHOT = Path(__file__).with_name("recipe.json")
_CAPABILITY_FILE = _ROOT / "capabilities.json"
_REPORT_LOCK = Lock()
_report = None


def _snapshot():
    # Only this installed module's adjacent snapshot is authorized. Never follow
    # a replaced snapshot link into another home or an environment-selected path.
    if _SNAPSHOT.is_symlink() or _SNAPSHOT.resolve().parent != _ROOT:
        raise ValueError("recipe-switch snapshot escapes the installed plugin directory")
    snapshot = json.loads(_SNAPSHOT.read_text(encoding="utf-8"))
    if snapshot.get("managedBy") != "recipe-switch":
        raise ValueError("Not a recipe-switch snapshot")
    return snapshot


def _texts():
    return _snapshot().get("texts", {})


def _hermes_version(ctx):
    for key in ("hermes_version", "version"):
        value = getattr(ctx, key, None)
        if isinstance(value, str) and value:
            return value
    try:
        return distribution_version("hermes-agent")
    except PackageNotFoundError:
        return "unknown (source checkout)"


def _write_report():
    # Atomic adjacent report only; never follow a user-replaced report symlink.
    temp = _ROOT / (".capabilities-" + uuid.uuid4().hex + ".tmp")
    try:
        if _CAPABILITY_FILE.is_symlink() or _CAPABILITY_FILE.resolve().parent != _ROOT:
            raise ValueError("recipe-switch capability report escapes the installed plugin directory")
        with temp.open("x", encoding="utf-8") as handle:
            json.dump(_report, handle, ensure_ascii=False)
            handle.write("\n")
        os.replace(temp, _CAPABILITY_FILE)
    except (OSError, ValueError) as error:
        warnings.warn("recipe-switch could not save runtime capabilities: " + str(error), RuntimeWarning)
    finally:
        temp.unlink(missing_ok=True)


def _registered(ctx):
    global _report
    with _REPORT_LOCK:
        _report = {"managedBy": "recipe-switch", "middleware_registered": True,
                   "hermes_version": _hermes_version(ctx), "registered_at": datetime.now(timezone.utc).isoformat(),
                   "llm_request_seen": False}
        _write_report()


def _request_seen():
    with _REPORT_LOCK:
        if _report is not None and not _report["llm_request_seen"]:
            _report["llm_request_seen"] = True
            _report["llm_request_seen_at"] = datetime.now(timezone.utc).isoformat()
            _write_report()


def _append(content, text):
    if isinstance(content, str):
        return content if text in content else content + ("\n\n" if content else "") + text
    if isinstance(content, list) and all(
        isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str)
        for part in content
    ):
        if any(text in part["text"] for part in content):
            return content
        return content + [{"type": "text", "text": text}]
    return None


def _append_bedrock(content, text):
    if not isinstance(content, list) or not all(
        isinstance(part, dict) and (
            isinstance(part.get("text"), str) and "type" not in part
            or set(part) == {"cachePoint"} and isinstance(part["cachePoint"], dict)
        ) for part in content
    ):
        return None
    if any(text in part.get("text", "") for part in content):
        return content
    # Keep the native cache boundary last so it covers the appended recipe.
    at = len(content) - 1 if content and "cachePoint" in content[-1] else len(content)
    return content[:at] + [{"text": text}] + content[at:]


def _with_system_text(request, text, api_mode):
    # Provider kwargs arrive after Hermes's transport preflight. Preserve all
    # other fields and copy only the instruction slot being changed.
    slots = {
        "codex_responses": ("instructions", _append),
        "anthropic_messages": ("system", _append),
        "bedrock_converse": ("system", _append_bedrock),
    }
    if api_mode in slots:
        key, append = slots[api_mode]
        original = request.get(key)
        if key == "instructions" and not isinstance(original, str):
            return None
        content = append(original, text)
        if content is None or content == original:
            return None
        return {**request, key: content}
    if api_mode != "chat_completions":
        return None
    messages = request.get("messages")
    if not isinstance(messages, list):
        return None
    instructions = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or message.get("role") not in {"system", "developer"}:
            continue
        content = _append(message.get("content"), text)
        if content is None or content == message.get("content"):
            return None
        instructions.append((index, {**message, "content": content}))
    if not instructions:
        return None
    index, message = instructions[0]
    changed = list(messages)
    changed[index] = message
    return {**request, "messages": changed}


def _request_middleware():
    # Keep the first role/text for each session for this plugin generation.
    # No eviction: a resumed session must not adopt a mid-conversation switch.
    frozen = {}
    lock = Lock()

    def inject(request=None, session_id=None, platform=None, api_mode=None, **kwargs):
        _request_seen()
        if not isinstance(request, dict) or not isinstance(session_id, str) or not session_id:
            return None
        with lock:
            if session_id not in frozen:
                role = "sub" if platform == "subagent" else "main"
                frozen[session_id] = _texts().get(role) or ""
            text = frozen[session_id]
        if not text:
            return None
        changed = _with_system_text(request, text, api_mode)
        return {"request": changed} if changed is not None else None

    return inject


def _steer(platform=None, parent_session_id=None, **kwargs):
    role = "subSteer" if platform == "subagent" or parent_session_id else "userSteer"
    text = _texts().get(role)
    return {"context": text} if text else None


def register(ctx):
    if _snapshot().get("hermesMiddleware") is True and callable(getattr(ctx, "register_middleware", None)):
        ctx.register_middleware("llm_request", _request_middleware())
        _registered(ctx)
    ctx.register_hook("pre_llm_call", _steer)
