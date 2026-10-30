"""Behavior recipe plugin, managed by recipe-switch."""
import json
from pathlib import Path
from threading import Lock

_ROOT = Path(__file__).resolve().parent
_SNAPSHOT = Path(__file__).with_name("recipe.json")


def _texts():
    # Only this installed module's adjacent snapshot is authorized. Never follow
    # a replaced snapshot link into another home or an environment-selected path.
    if _SNAPSHOT.is_symlink() or _SNAPSHOT.resolve().parent != _ROOT:
        raise ValueError("recipe-switch snapshot escapes the installed plugin directory")
    snapshot = json.loads(_SNAPSHOT.read_text(encoding="utf-8"))
    if snapshot.get("managedBy") != "recipe-switch":
        raise ValueError("Not a recipe-switch snapshot")
    return snapshot.get("texts", {})


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
    ctx.register_middleware("llm_request", _request_middleware())
    ctx.register_hook("pre_llm_call", _steer)
