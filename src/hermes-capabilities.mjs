// Read-only capability evidence. Host Python is parsed, never imported/executed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readFile, decode, toPosix, assertBoundary, captureBoundary} from './fsx.mjs';

const AST_PROBE = String.raw`
import ast, json, sys
sources = json.load(sys.stdin)
try:
    trees = [ast.parse(row['text'], filename=row['path']) for row in sources]
except (SyntaxError, ValueError) as error:
    print(json.dumps({'registration': False, 'dispatch': False, 'reason': 'Python AST parse failed: ' + type(error).__name__}))
    sys.exit(0)
classes = {node.name: node for node in trees[0].body if isinstance(node, ast.ClassDef)}
def method(name, seen):
    if name in seen or name not in classes:
        return False
    seen = seen | {name}
    cls = classes[name]
    for member in reversed(cls.body):
        if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)) and member.name == 'register_middleware':
            return not any(isinstance(d, ast.Name) and d.id in ('property', 'cached_property') for d in member.decorator_list)
        if isinstance(member, (ast.Assign, ast.AnnAssign)):
            targets = member.targets if isinstance(member, ast.Assign) else [member.target]
            if any(isinstance(t, ast.Name) and t.id == 'register_middleware' for t in targets):
                return False
    return any(method(base.id, seen) for base in cls.bases if isinstance(base, ast.Name))
def named(node):
    return node.attr if isinstance(node, ast.Attribute) else node.id if isinstance(node, ast.Name) else ''
def llm(node):
    return isinstance(node, ast.Constant) and node.value == 'llm_request'
def dispatch(call):
    if not isinstance(call, ast.Call):
        return False
    fn = call.func
    if isinstance(fn, ast.Subscript) and llm(fn.slice) and named(fn.value) in ('middleware', '_middleware', 'middlewares', '_middlewares'):
        return True
    names = ('run_middleware', 'dispatch_middleware', 'execute_middleware', 'apply_middleware', 'call_middleware', 'invoke_middleware')
    return named(fn) in names and (any(llm(arg) for arg in call.args) or any(llm(kw.value) for kw in call.keywords))
registration = method('PluginContext', set())
# Only request-path code is considered, not plugins.py examples/registration.
request_dispatch = any(dispatch(node) for tree in trees[1:] for node in ast.walk(tree))
reason = None if registration and request_dispatch else 'PluginContext has no register_middleware method' if not registration else 'No llm_request middleware dispatch in run_agent.py or agent/'
print(json.dumps({'registration': registration, 'dispatch': request_dispatch, 'reason': reason}))
`;

async function parseWithPython(sources, env) {
  for (const [command, prefix] of [['python', []], ['py', ['-3']]]) {
    const result = await new Promise(resolve => {
      const child = spawn(command, [...prefix, '-I', '-B', '-c', AST_PROBE], {
        env: {...process.env, ...env, PYTHONDONTWRITEBYTECODE: '1'}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      });
      let output = '', errors = '', settled = false;
      const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { child.kill(); done({reason: 'Python AST probe timed out'}); }, 10000);
      child.on('error', error => done({unavailable: ['ENOENT', 'EACCES'].includes(error.code), reason: 'Python unavailable (python / py -3)'}));
      child.stdout.on('data', bytes => { output += bytes; });
      child.stderr.on('data', bytes => { errors += bytes; });
      child.on('close', code => {
        if (code !== 0) return done({reason: 'Python AST probe failed'});
        try { done(JSON.parse(output)); } catch { done({reason: 'Python AST probe returned invalid evidence'}); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(sources));
    });
    if (!result.unavailable) return result;
  }
  return {reason: 'Python unavailable (python / py -3)'};
}

export async function probeHermes(home, {env = process.env} = {}) {
  const unavailable = (reason, source = null) => ({main: false, sub: false, userSteer: true, subSteer: true, llmRequest: false, source, reason});
  for (const root of [path.join(home, 'hermes-agent'), home]) {
    const file = path.join(root, 'hermes_cli', 'plugins.py');
    let bytes;
    try { bytes = await readFile(file); } catch { return unavailable('Hermes source cannot be read', toPosix(file)); }
    if (bytes === null) continue;
    try {
      const sources = [{path: toPosix(file), text: decode(bytes)}];
      const boundary = await captureBoundary(root);
      await assertBoundary(file, boundary);
      const add = async file => {
        await assertBoundary(file, boundary);
        const bytes = await readFile(file);
        if (bytes !== null) sources.push({path: toPosix(file), text: decode(bytes)});
      };
      await add(path.join(root, 'run_agent.py'));
      const walk = async dir => {
        await assertBoundary(dir, boundary);
        const entries = await fs.readdir(dir, {withFileTypes: true}).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
        for (const entry of entries) {
          if (entry.isSymbolicLink()) throw new Error('Linked Hermes request source');
          if (entry.isDirectory()) await walk(path.join(dir, entry.name));
          else if (entry.name.endsWith('.py')) await add(path.join(dir, entry.name));
        }
      };
      await walk(path.join(root, 'agent'));
      const evidence = await parseWithPython(sources, env), llmRequest = evidence.registration === true && evidence.dispatch === true;
      return {main: llmRequest, sub: llmRequest, userSteer: true, subSteer: true, llmRequest, source: toPosix(file), reason: evidence.reason ?? null};
    } catch { return unavailable('Hermes request source cannot be read safely', toPosix(file)); }
  }
  return unavailable('Hermes source not found');
}
