// Static eligibility parses host Python without importing it. Runtime evidence is
// reported by our installed plugin only after registration / a real request.
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readFile, decode, toPosix, assertBoundary, captureBoundary} from './fsx.mjs';

const AST_PROBE = String.raw`
import ast, json, sys
source = json.load(sys.stdin)
try:
    tree = ast.parse(source['text'], filename=source['path'])
except (SyntaxError, ValueError) as error:
    print(json.dumps({'registration': False, 'reason': 'Python AST parse failed: ' + type(error).__name__}))
    sys.exit(0)
classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == 'PluginContext']
registration = False
if len(classes) == 1:
    cls = classes[0]
    methods = [node for node in cls.body if isinstance(node, ast.FunctionDef) and node.name == 'register_middleware' and not node.decorator_list]
    def shadow(node):
        # Reject both class attributes and an instance attribute assigned by a method.
        if not isinstance(node, (ast.Assign, ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
            return False
        targets = node.targets if isinstance(node, ast.Assign) else [node.target]
        return any((isinstance(t, ast.Name) and t.id == 'register_middleware') or
                   (isinstance(t, ast.Attribute) and t.attr == 'register_middleware')
                   for target in targets for t in ast.walk(target))
    registration = len(methods) == 1 and not any(shadow(node) for node in ast.walk(cls))
print(json.dumps({'registration': registration, 'reason': None if registration else 'PluginContext has no unshadowed direct def register_middleware'}))
`;

async function parseWithPython(source, env) {
  for (const [command, prefix] of [['python', []], ['py', ['-3']]]) {
    const result = await new Promise(resolve => {
      const child = spawn(command, [...prefix, '-I', '-B', '-c', AST_PROBE], {
        env: {...process.env, ...env, PYTHONDONTWRITEBYTECODE: '1'}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      let output = '', settled = false;
      const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { child.kill(); done({reason: 'Python AST probe timed out'}); }, 10000);
      child.on('error', error => done({unavailable: ['ENOENT', 'EACCES'].includes(error.code), reason: 'Python unavailable (python / py -3)'}));
      child.stdout.on('data', bytes => { output += bytes; });
      child.stderr.resume();
      child.on('close', code => {
        if (code !== 0) return done({reason: 'Python AST probe failed'});
        try { done(JSON.parse(output)); } catch { done({reason: 'Python AST probe returned invalid evidence'}); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(source));
    });
    if (!result.unavailable) return result;
  }
  return {reason: 'Python unavailable (python / py -3)'};
}

async function runtimeEvidence(home) {
  const file = path.join(home, 'plugins', 'recipe-switch', 'capabilities.json');
  try {
    await assertBoundary(file, await captureBoundary(home));
    const bytes = await readFile(file), report = bytes === null ? null : JSON.parse(decode(bytes));
    if (report?.managedBy === 'recipe-switch' && report.middleware_registered === true && typeof report.registered_at === 'string' && typeof report.hermes_version === 'string')
      return {status: report.llm_request_seen === true ? 'confirmed' : 'registered', report};
  } catch {} // Missing, malformed or linked reports are unknown, never positive evidence.
  return {status: 'unknown', report: null};
}

export async function probeHermes(home, {env = process.env} = {}) {
  const runtime = await runtimeEvidence(home);
  const result = (registration, reason, source = null) => {
    const confirmed = registration && runtime.status === 'confirmed';
    const state = registration ? runtime.status : 'unsupported';
    const statusText = state === 'confirmed' ? '已确认生效 / Confirmed active'
      : state === 'registered' ? '已注册，尚未见到请求 / Registered; no request seen yet'
      : state === 'unknown' ? '未知：请启动一次 Hermes / Unknown: start Hermes once'
      : '不支持：只装每轮 steering / Unsupported: per-turn steering only';
    return {main: confirmed, sub: confirmed, userSteer: true, subSteer: true, llmRequest: registration,
      state, statusText, report: registration ? runtime.report : null, source, reason};
  };
  for (const root of [path.join(home, 'hermes-agent'), home]) {
    const file = path.join(root, 'hermes_cli', 'plugins.py');
    try {
      await assertBoundary(file, await captureBoundary(root));
      const bytes = await readFile(file);
      if (bytes === null) continue;
      const evidence = await parseWithPython({path: toPosix(file), text: decode(bytes)}, env);
      return result(evidence.registration === true, evidence.reason ?? null, toPosix(file));
    } catch { return result(false, 'Hermes source cannot be read safely', toPosix(file)); }
  }
  return result(false, 'Hermes source not found');
}
