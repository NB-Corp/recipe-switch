"""Exercise the installed Hermes plugin without importing Hermes or user state."""
import copy
import importlib.util
import json
from pathlib import Path
import sys

entry = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("recipe_switch_fixture", entry)
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
snapshot_path = entry.with_name("recipe.json")
snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
texts = snapshot["texts"]
assert len(texts["main"]) > 7600 and len(texts["sub"]) > 7600


class Context:
    def __init__(self):
        self.middleware = {}
        self.hooks = {}

    def register_middleware(self, name, callback):
        self.middleware[name] = callback

    def register_hook(self, name, callback):
        self.hooks[name] = callback


ctx = Context()
plugin.register(ctx)
assert set(ctx.middleware) == {"llm_request"}
assert set(ctx.hooks) == {"pre_llm_call"}
inject = ctx.middleware["llm_request"]


def request_for(shape):
    request = {"model": "fixture-model", "temperature": 0.4, "tools": [{"fixture": True}]}
    if shape == "chat-string":
        request["messages"] = [{"role": "system", "content": "HOST"}, {"role": "user", "content": "hello"}]
    elif shape == "chat-parts":
        request["messages"] = [
            {"role": "system", "content": [{"type": "text", "text": "HOST", "cache_control": {"type": "ephemeral"}}]},
            {"role": "user", "content": "hello"},
        ]
    elif shape == "anthropic-string":
        request.update(system="HOST", messages=[{"role": "user", "content": "hello"}])
    elif shape == "anthropic-parts":
        request.update(system=[{"type": "text", "text": "HOST", "cache_control": {"type": "ephemeral"}}],
                       messages=[{"role": "user", "content": [{"type": "text", "text": "hello"}]}])
    elif shape == "responses":
        request.update(instructions="HOST", input=[{"role": "user", "content": "hello"}], store=False)
    elif shape.startswith("developer-"):
        request = request_for(shape.replace("developer-", "chat-"))
        request["messages"][0]["role"] = "developer"
    elif shape in {"bedrock", "bedrock-cached"}:
        request = {"modelId": "fixture-model", "system": [{"text": "HOST"}],
                   "messages": [{"role": "user", "content": [{"text": "hello"}]}],
                   "inferenceConfig": {"temperature": 0.4}, "__bedrock_converse__": True}
        if shape == "bedrock-cached":
            request["system"].append({"cachePoint": {"type": "default"}})
    else:
        raise AssertionError(shape)
    return request


def expected(request, text):
    result = copy.deepcopy(request)
    if "instructions" in result:
        result["instructions"] += "\n\n" + text
    elif "system" in result:
        if isinstance(result["system"], str):
            result["system"] += "\n\n" + text
        elif "modelId" in result:
            if "cachePoint" in result["system"][-1]:
                result["system"].insert(len(result["system"]) - 1, {"text": text})
            else:
                result["system"].append({"text": text})
        else:
            result["system"].append({"type": "text", "text": text})
    else:
        content = result["messages"][0]["content"]
        if isinstance(content, str):
            result["messages"][0]["content"] += "\n\n" + text
        else:
            content.append({"type": "text", "text": text})
    return result


def apply(request, session_id, platform, api_mode):
    before = copy.deepcopy(request)
    result = inject(request=request, original_request=copy.deepcopy(request), session_id=session_id,
                    platform=platform, api_mode=api_mode, model="fixture-model")
    assert request == before, "middleware mutated input request"
    if result is None:
        return request
    assert set(result) == {"request"}
    return result["request"]


shapes = [
    ("chat-string", "chat_completions"),
    ("chat-parts", "chat_completions"),
    ("developer-string", "chat_completions"),
    ("developer-parts", "chat_completions"),
    ("anthropic-string", "anthropic_messages"),
    ("anthropic-parts", "anthropic_messages"),
    ("responses", "codex_responses"),
    ("bedrock", "bedrock_converse"),
    ("bedrock-cached", "bedrock_converse"),
]
original_outputs = {}
for shape, api_mode in shapes:
    for role, platform in [("main", "cli"), ("sub", "subagent")]:
        sid = shape + ":" + role
        request = request_for(shape)
        first = apply(request, sid, platform, api_mode)
        assert first == expected(request, texts[role]), (shape, role, "full text or other kwargs changed")
        assert json.dumps(apply(request, sid, platform, api_mode), ensure_ascii=False) == json.dumps(first, ensure_ascii=False)
        assert apply(first, sid, platform, api_mode) == first, "recipe appended twice"
        original_outputs[sid] = first

# Session role is frozen with its text, including a provider/mode transition.
assert apply(request_for("responses"), "chat-string:main", "subagent", "codex_responses") == expected(request_for("responses"), texts["main"])
assert ctx.hooks["pre_llm_call"](platform="cli") == {"context": texts["userSteer"]}
assert ctx.hooks["pre_llm_call"](platform="subagent") == {"context": texts["subSteer"]}
assert ctx.hooks["pre_llm_call"](parent_session_id="parent") == {"context": texts["subSteer"]}

# The installed module stays loaded while the atomic snapshot changes.
switched = copy.deepcopy(snapshot)
switched["texts"].update(main="NEW MAIN\n" + texts["main"], sub="NEW SUB\n" + texts["sub"],
                         userSteer="NEXT USER", subSteer="NEXT SUB")
snapshot_path.write_text(json.dumps(switched), encoding="utf-8")
for shape, api_mode in shapes:
    for role, platform in [("main", "cli"), ("sub", "subagent")]:
        request = request_for(shape)
        sid = shape + ":" + role
        assert apply(request, sid, platform, api_mode) == original_outputs[sid], "switch changed existing session bytes"
        assert apply(request, "new:" + sid, platform, api_mode) == expected(request, switched["texts"][role])
assert ctx.hooks["pre_llm_call"](platform="cli") == {"context": "NEXT USER"}
assert ctx.hooks["pre_llm_call"](platform="subagent") == {"context": "NEXT SUB"}

for request, mode in [
    ({}, "chat_completions"), ({"input": []}, "codex_responses"),
    ({"messages": [{"role": "user", "content": "hello"}]}, "chat_completions"),
    ({"instructions": [{"type": "text", "text": "unknown Responses shape"}]}, "codex_responses"),
    ({"system": None}, "anthropic_messages"),
    ({"system": [{"type": "unknown", "text": "HOST"}]}, "anthropic_messages"),
    ({"messages": [{"role": "system", "content": 7}]}, "chat_completions"),
    ({"system": [{"type": "text", "text": "wrong Bedrock shape"}]}, "bedrock_converse"),
    (request_for("chat-string"), "unknown"),
]:
    before = copy.deepcopy(request)
    assert inject(request=request, session_id="unknown", platform="cli", api_mode=mode) is None
    assert request == before
for sid in [None, ""]:
    assert inject(request=request_for("chat-string"), session_id=sid, platform="cli") is None

# Even an empty selected role is frozen instead of adopting a later recipe.
switched["texts"]["sub"] = None
snapshot_path.write_text(json.dumps(switched), encoding="utf-8")
assert inject(request=request_for("chat-string"), session_id="empty-sub", platform="subagent", api_mode="chat_completions") is None
switched["texts"]["sub"] = "LATER SUB"
snapshot_path.write_text(json.dumps(switched), encoding="utf-8")
assert inject(request=request_for("chat-string"), session_id="empty-sub", platform="subagent", api_mode="chat_completions") is None
assert apply(request_for("chat-string"), "later-sub", "subagent", "chat_completions") == expected(request_for("chat-string"), "LATER SUB")

print("Hermes full middleware OK: main=%d sub=%d shapes=%d" % (len(texts["main"]), len(texts["sub"]), len(shapes)))
