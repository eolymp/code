const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ws = require('./workspace');
const runner = require('./runner');
const companion = require('./companion');
const toolset = require('./tools');
const doctor = require('./doctor');

const TEMPLATES = {
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n',
  py: 'import sys\ninput = sys.stdin.readline\n\n',
};
const CURSOR = { cpp: new vscode.Position(4, 4), py: new vscode.Position(3, 0) };
const t = vscode.l10n.t;
const FINAL = ['runtime error', 'time limit', 'memory limit', 'output limit'];
const SHOWN = 256 << 10;

const states = new Map();
const changed = new vscode.EventEmitter();
const outputs = new vscode.EventEmitter();
let view;
let target;
let active;
let testing;
let pending;
let toolsRoot;
let managed;
const standIn = process.platform === 'darwin' && !toolset.wanted() ? path.join(__dirname, 'include') : '';
let setup;
let terminalEnv;
let building = Promise.resolve();
let starting = false;

function config() {
  return vscode.workspace.getConfiguration('eolympCode');
}

function root() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders[0].uri.fsPath;
}

function stateOf(file) {
  if (!states.has(file)) states.set(file, { results: {}, compileError: '', steps: null, session: null });
  return states.get(file);
}

function sync(state, dir) {
  const ids = new Set(ws.testIds(dir));
  for (const [id, r] of Object.entries(state.results)) {
    if (!ids.has(id)) delete state.results[id];
    else if (r.verdict !== 'running' && !FINAL.includes(r.verdict)) {
      const answer = ws.answerOf(dir, id);
      if (r.judged !== answer) r.verdict = ws.verdictOf(r.stdout, answer);
      r.judged = answer;
    }
  }
  return state.results;
}

function solutionIn(document) {
  return document && document.uri.scheme === 'file' ? ws.solutionOf(document.fileName) : undefined;
}

function toolDirs() {
  if (managed) return [path.dirname(managed.cxx), path.dirname(managed.python)];
  return path.isAbsolute(cxxPath()) ? [path.dirname(cxxPath())] : [];
}

function toolEnv() {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[key] = [...toolDirs(), env[key] || ''].join(path.delimiter);
  if (managed) Object.assign(env, managed.env);
  else if (config().get('includePath') || standIn) env.CPLUS_INCLUDE_PATH = config().get('includePath') || standIn;
  env.PYTHONUTF8 = '1';
  return env;
}

function cxxPath() {
  return managed ? managed.cxx : config().get('cxx');
}

function cxxFlags() {
  return [...config().get('cxxFlags'), ...(managed ? managed.flags : [])];
}

function pythonPath() {
  return (managed && managed.python) || config().get('python') || (process.platform === 'win32' ? 'python' : 'python3');
}

function shortName(command) {
  return path.basename(command).replace(/\.exe$/i, '');
}

function build(s, debug) {
  const built = building.then(() => compile(s, debug)).catch((err) => ({ ok: false, command: '', args: [], compile: '', log: t('Could not build: {0}', err.message), run: '' }));
  building = built;
  return built;
}

async function compile(s, debug) {
  const source = path.basename(s.file);
  if (s.lang === 'py') return { ok: true, command: pythonPath(), args: [s.file], compile: '', log: '', run: `${shortName(pythonPath())} ${source}` };
  fs.mkdirSync(s.outDir, { recursive: true });
  const cxx = cxxPath();
  const exe = path.join(s.outDir, (debug ? 'debug' : 'run') + (process.platform === 'win32' ? '.exe' : ''));
  const flags = debug ? [...cxxFlags().filter((f) => !f.startsWith('-O')), '-g', '-O0'] : cxxFlags();
  const r = await runner.collect(cxx, [...flags, s.file, '-o', exe], { cwd: s.dir, env: toolEnv() });
  const shown = path.relative(s.dir, exe);
  return {
    ok: r.code === 0,
    command: exe,
    args: [],
    compile: `${shortName(cxx)} ${flags.join(' ')} ${source} -o ${shown}`,
    log: r.missing ? t('The compiler was not found: {0}', cxx) : r.stderr.trim(),
    run: shown,
  };
}

function flush() {
  pending = undefined;
  if (!view) return;
  const state = target && stateOf(target.file);
  const x = state && state.session;
  view.webview.postMessage({
    file: target ? path.basename(target.file) : '',
    meta: target ? ws.loadMeta(target.dir) : {},
    path: target ? target.file : '',
    tests: target ? ws.testIds(target.dir).map((id) => ({ id, answered: ws.answerOf(target.dir, id) !== undefined })) : [],
    results: state ? Object.fromEntries(Object.entries(sync(state, target.dir)).map(([id, r]) => [id, shownResult(r)])) : {},
    compileError: state ? state.compileError : '',
    steps: state ? state.steps : null,
    session: x ? { parts: x.parts, hidden: x.size - x.shown, closed: x.closed, state: x.state, code: x.code, signal: x.signal, stopped: x.stopped, flooded: x.flooded, ms: x.ms, memory: x.memory, kept: x.kept, typed: x.input !== '' } : null,
  });
}

function shownResult(r) {
  const cut = (text) => (text && text.length > SHOWN ? text.slice(0, SHOWN) : text);
  const hidden = Math.max(0, (r.stdout || '').length - SHOWN);
  return { verdict: r.verdict, ms: r.ms, memory: r.memory, code: r.code, signal: r.signal, changed: r.changed, stdout: cut(r.stdout), stderr: cut(r.stderr), hidden };
}

function update() {
  if (!pending) pending = setTimeout(flush, 40);
}

function refresh() {
  changed.fire();
  update();
}

function setBusy() {
  vscode.commands.executeCommand('setContext', 'eolympCode.running', Boolean(testing || (active && active.state !== 'finished')));
}

function stopActive() {
  if (!active) return Promise.resolve();
  const child = active.child;
  stateOf(active.file).session = null;
  active = undefined;
  setBusy();
  if (!child) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

function say(session, kind, text) {
  if (session.size >= runner.OUTPUT_LIMIT) return;
  const room = runner.OUTPUT_LIMIT - session.size;
  const kept = text.length > room ? text.slice(0, room) : text;
  session.size += kept.length;
  if (kind === 'out') session.output += kept;
  const shown = kept.slice(0, Math.max(0, SHOWN - session.shown));
  session.shown += shown.length;
  const last = session.parts[session.parts.length - 1];
  if (shown && last && last.kind === kind) last.text += shown;
  else if (shown) session.parts.push({ kind, text: shown });
  if (session.size >= runner.OUTPUT_LIMIT && session.child) {
    session.flooded = true;
    session.child.kill();
  }
  update();
}

async function prepare(node, missing) {
  const picked = node && node.kind === 'solution';
  const document = picked ? await vscode.workspace.openTextDocument(node.file) : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  const s = solutionIn(document);
  if (!s) {
    vscode.window.showInformationMessage(missing);
    return undefined;
  }
  if (testing || starting) return undefined;
  starting = true;
  try {
    if (picked) await vscode.window.showTextDocument(document);
    await document.save();
    await stopActive();
    target = s;
    await vscode.commands.executeCommand('eolympCode.tests.focus');
  } finally {
    starting = false;
  }
  return s;
}

async function run(node) {
  const s = await prepare(node, t('Open a .cpp or .py file to run it.'));
  if (!s) return;
  const state = stateOf(s.file);
  const mine = { file: s.file, dir: s.dir, parts: [], size: 0, shown: 0, state: 'compiling', input: '', output: '' };
  state.session = mine;
  active = mine;
  setBusy();
  update();
  const built = await build(s, false);
  if (active !== mine) return;
  state.steps = { compile: built.compile, run: built.run, ok: built.ok };
  state.compileError = built.log;
  if (!built.ok) {
    await stopActive();
    update();
    return;
  }
  const wrapped = await runner.measured(pythonPath(), built.command, s.lang === 'py' ? ['-u', ...built.args] : built.args);
  if (active !== mine) return;
  const started = Date.now();
  mine.state = 'running';
  mine.child = runner.start(wrapped.command, wrapped.args, { cwd: s.dir, env: toolEnv() });
  mine.child.stdin.on('error', () => {});
  mine.child.stdout.setEncoding('utf8');
  mine.child.stderr.setEncoding('utf8');
  mine.child.stdout.on('data', (d) => say(mine, 'out', d));
  mine.child.stderr.on('data', (d) => say(mine, 'err', d));
  const finish = (code, signal, text) => {
    if (mine.state === 'finished') return;
    const r = wrapped.finish({ code, signal, ms: Date.now() - started });
    Object.assign(mine, { state: 'finished', child: undefined, code: r.code, signal: r.signal, ms: r.ms, memory: r.memory });
    if (text || r.failure) say(mine, 'err', text || `${r.failure}\n`);
    if (active === mine) active = undefined;
    setBusy();
    update();
  };
  mine.child.on('error', (err) => finish(-1, undefined, `${err.message}\n`));
  mine.child.on('close', (code, signal) => finish(code, signal));
  update();
}

function keepSession() {
  const state = target && stateOf(target.file);
  const x = state && state.session;
  if (!x || x.state !== 'finished' || x.kept) return;
  const id = ws.nextTest(x.dir);
  ws.saveTest(x.dir, id, x.input, undefined);
  state.results[id] = { verdict: 'no answer', ms: x.ms, memory: x.memory, stdout: x.output };
  x.kept = id;
  refresh();
}

async function runTests(node) {
  const s = await prepare(node, t('Open a .cpp or .py file to test it.'));
  if (!s) return;
  const state = stateOf(s.file);
  const previous = { ...sync(state, s.dir) };
  const job = { cancelled: false };
  state.results = {};
  state.session = null;
  testing = job;
  setBusy();
  update();
  try {
    await runAll(s, state, previous, job);
  } catch (err) {
    state.compileError = t('Could not run the tests: {0}', err.message);
  } finally {
    testing = undefined;
    setBusy();
    refresh();
  }
}

async function runAll(s, state, previous, job) {
  const built = await build(s, false);
  state.steps = { compile: built.compile, run: built.run, ok: built.ok };
  state.compileError = built.log;
  const meta = ws.loadMeta(s.dir);
  const timeLimit = meta.timeLimit > 0 ? meta.timeLimit : config().get('timeLimit');
  const memoryLimit = meta.memoryLimit > 0 ? meta.memoryLimit * 1048576 : Infinity;
  for (const test of built.ok ? ws.loadTests(s.dir) : []) {
    if (job.cancelled) break;
    state.results[test.id] = { verdict: 'running' };
    update();
    const options = { cwd: s.dir, env: toolEnv(), timeout: timeLimit + 1000, python: pythonPath(), onStart: (child) => { job.child = child; if (job.cancelled) child.kill(); } };
    const r = await runner.collect(built.command, built.args, options, test.input);
    if (job.cancelled) {
      delete state.results[test.id];
      break;
    }
    let verdict = ws.verdictOf(r.stdout, test.answer);
    if (r.flooded) verdict = 'output limit';
    else if (r.timedOut || r.ms > timeLimit) verdict = 'time limit';
    else if (r.memory > memoryLimit) verdict = 'memory limit';
    else if (r.code !== 0) verdict = 'runtime error';
    const before = previous[test.id];
    const differs = Boolean(before) && ws.normalize(before.stdout) !== ws.normalize(r.stdout);
    state.results[test.id] = { verdict, ms: r.ms, memory: r.memory, code: r.code, signal: r.signal, stdout: r.stdout, stderr: r.stderr, changed: differs, previous: differs ? before.stdout : before && before.previous };
  }
}

function stop() {
  if (active && active.state === 'compiling') stopActive().then(update);
  else if (testing) {
    testing.cancelled = true;
    if (testing.child) testing.child.kill();
  } else if (active && active.child) {
    active.stopped = true;
    active.child.kill();
  }
}

async function debugTest(id) {
  if (!target) return;
  const s = target;
  const uri = vscode.Uri.file(s.file);
  const document = await vscode.workspace.openTextDocument(uri);
  await document.save();
  const built = await build(s, true);
  if (!built.ok) {
    stateOf(s.file).compileError = built.log;
    update();
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const input = path.join(s.dir, `${id}.in`);
  const hasBreakpoint = vscode.debug.breakpoints.some((b) => b instanceof vscode.SourceBreakpoint && b.location.uri.fsPath === s.file);
  if (s.lang === 'cpp') {
    await vscode.debug.startDebugging(folder, {
      type: 'lldb',
      request: 'launch',
      name: t('Test {0}', id),
      program: built.command,
      cwd: s.dir,
      env: toolEnv(),
      stdio: [input, null, null],
      preRunCommands: hasBreakpoint ? [] : ['breakpoint set --name main --one-shot true'],
    });
    return;
  }
  const first = document.getText().split('\n').findIndex((line) => line.trim() && !line.trim().startsWith('#'));
  const entry = hasBreakpoint || first < 0 ? [] : [new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(first, 0)))];
  vscode.debug.addBreakpoints(entry);
  const started = await vscode.debug.startDebugging(folder, {
    type: 'debugpy',
    request: 'launch',
    name: t('Test {0}', id),
    python: built.command,
    program: path.join(__dirname, 'debug.py'),
    args: [s.file, input],
    cwd: s.dir,
    env: { PYDEVD_DISABLE_FILE_VALIDATION: '1' },
    console: 'internalConsole',
  });
  if (!started) {
    vscode.debug.removeBreakpoints(entry);
    return;
  }
  const debugging = vscode.debug.activeDebugSession;
  const done = vscode.debug.onDidTerminateDebugSession((ended) => {
    if (debugging && ended.id !== debugging.id) return;
    vscode.debug.removeBreakpoints(entry);
    done.dispose();
  });
}

function acceptOutput(id) {
  const r = sync(stateOf(target.file), target.dir)[id];
  if (!r || r.verdict === 'running' || FINAL.includes(r.verdict)) return;
  fs.writeFileSync(path.join(target.dir, `${id}.answer`), r.stdout);
  refresh();
}

function outputUri(s, id, kind) {
  return vscode.Uri.from({ scheme: 'eolymp-output', path: `/${id}.${kind}`, query: JSON.stringify({ file: s.file, id, kind }) });
}

async function showDiff(id) {
  const s = target;
  const r = sync(stateOf(s.file), s.dir)[id];
  const answer = path.join(s.dir, `${id}.answer`);
  const answered = fs.existsSync(answer);
  if (!r || (!answered && r.previous === undefined)) {
    vscode.window.showInformationMessage(t('There is nothing to compare this output with yet.'));
    return;
  }
  const base = answered ? vscode.Uri.file(answer) : outputUri(s, id, 'previous');
  const output = outputUri(s, id, 'out');
  outputs.fire(base);
  outputs.fire(output);
  const title = answered ? t('Test {0}: answer ↔ output of {1}', id, path.basename(s.file)) : t('Test {0}: previous output ↔ output of {1}', id, path.basename(s.file));
  await vscode.commands.executeCommand('vscode.diff', base, output, title);
}

function checkSetup() {
  return setup.open();
}

function adopt() {
  managed = toolset.installed(toolsRoot);
  runner.forget();
  terminalEnv.clear();
  if (!managed && !standIn) return;
  const updates = [];
  const flags = ['-std=c++17'];
  if (managed) {
    terminalEnv.prepend(process.platform === 'win32' ? 'Path' : 'PATH', toolDirs().join(path.delimiter) + path.delimiter);
    for (const [name, value] of Object.entries(managed.env)) terminalEnv.replace(name, value);
    const python = vscode.workspace.getConfiguration('python');
    if (python.get('defaultInterpreterPath') !== managed.python) updates.push(python.update('defaultInterpreterPath', managed.python, vscode.ConfigurationTarget.Global));
    const clangd = vscode.workspace.getConfiguration('clangd');
    if (managed.clangd && clangd.get('path') !== managed.clangd) updates.push(clangd.update('path', managed.clangd, vscode.ConfigurationTarget.Global));
    const driver = `--query-driver=${path.dirname(managed.cxx)}${path.sep}*`;
    const args = clangd.get('arguments') || [];
    if (!args.includes(driver)) updates.push(clangd.update('arguments', [...args.filter((arg) => !arg.startsWith('--query-driver=')), driver], vscode.ConfigurationTarget.Global));
    if (managed.env.SDKROOT) flags.push('-isysroot', managed.env.SDKROOT);
  } else {
    terminalEnv.replace('CPLUS_INCLUDE_PATH', standIn);
    flags.push(`-I${standIn}`);
  }
  if (root()) {
    const file = path.join(root(), '.clangd');
    const text = `# Written by Eolymp Code\nCompileFlags:\n${managed ? `  Compiler: ${JSON.stringify(managed.cxx)}\n` : ''}  Add: ${JSON.stringify(flags)}\n`;
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Written by Eolymp Code';
    if (current.startsWith('# Written by Eolymp Code') && current !== text) {
      fs.writeFileSync(file, text);
      updates.push(Promise.resolve());
    }
  }
  if (updates.length) Promise.all(updates).then(() => vscode.commands.executeCommand('clangd.restart')).then(undefined, () => {});
}

async function submit() {
  if (!target) return;
  const url = companion.webUrl(ws.loadMeta(target.dir).url);
  if (!url) return;
  const document = await vscode.workspace.openTextDocument(target.file);
  await document.save();
  await vscode.env.clipboard.writeText(document.getText());
  await vscode.env.openExternal(vscode.Uri.parse(url));
  vscode.window.showInformationMessage(t('Your solution is copied. Paste it into the submit form on the problem page.'));
}

async function openSolution(file, lang) {
  const fresh = !fs.existsSync(file);
  if (fresh) fs.writeFileSync(file, TEMPLATES[lang]);
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  if (fresh) editor.selection = new vscode.Selection(CURSOR[lang], CURSOR[lang]);
  target = ws.solutionOf(file);
  refresh();
}

async function createProblem(name, tests, meta) {
  if (!root()) {
    vscode.window.showErrorMessage(t('Open a folder first: problems are created in it.'));
    return;
  }
  let slug = ws.slugOf(name);
  for (let n = 1; !slug; n++) if (!fs.existsSync(path.join(root(), `untitled-${n}`))) slug = `untitled-${n}`;
  const dir = path.join(root(), slug);
  fs.mkdirSync(dir, { recursive: true });
  if (tests && ws.testIds(dir).length === 0) tests.forEach((t, i) => ws.saveTest(dir, String(i + 1), t.input, t.output));
  const described = path.join(dir, 'problem.json');
  if (meta && !fs.existsSync(described)) fs.writeFileSync(described, JSON.stringify(meta, null, 2));
  const lang = config().get('language');
  await openSolution(ws.solutionsIn(dir)[0] || path.join(dir, `${slug}.${lang}`), lang);
}

function askName(options, taken) {
  return vscode.window.showInputBox({
    ...options,
    validateInput: (value) => (ws.badName(value) ? t('This name cannot be used for a file.') : value.trim() && taken(value.trim()) ? t('The name {0} is already used.', taken(value.trim())) : undefined),
  }).then((value) => (value || '').trim());
}

async function newProblem() {
  const name = await vscode.window.showInputBox({ prompt: t('Name of the problem'), placeHolder: t('Leave empty to name it later') });
  if (name !== undefined) await createProblem(name);
}

async function newSolution(node) {
  const lang = config().get('language');
  const named = (value) => (ws.langOf(value) ? value : `${value}.${lang}`);
  const name = await askName({ prompt: t('Name of the solution'), value: `brute.${lang}`, valueSelection: [0, 5] }, (value) => fs.existsSync(path.join(node.dir, named(value))) && named(value));
  if (!name) return;
  const file = path.join(node.dir, named(name));
  await openSolution(file, ws.langOf(file));
}

async function newTest(node) {
  const file = path.join(node.dir, `${ws.nextTest(node.dir)}.in`);
  fs.writeFileSync(file, '');
  refresh();
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function newFile(node) {
  const name = await askName({ prompt: t('Name of the file') }, (value) => fs.existsSync(path.join(node.dir, value)) && value);
  if (!name) return;
  const file = path.join(node.dir, name);
  fs.writeFileSync(file, '', { flag: 'wx' });
  await vscode.window.showTextDocument(vscode.Uri.file(file));
  refresh();
}

async function move(from, to) {
  const edit = new vscode.WorkspaceEdit();
  edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to));
  if (await vscode.workspace.applyEdit(edit) && fs.existsSync(to)) return true;
  vscode.window.showErrorMessage(t('Could not rename {0} to {1}.', path.basename(from), path.basename(to)));
  return false;
}

async function forget(file) {
  if (active && active.file === file) await stopActive();
  const state = states.get(file);
  states.delete(file);
  if (target && target.file === file) target = undefined;
  return state;
}

function recall(file, state) {
  if (state) states.set(file, { ...state, steps: null, session: null });
}

async function renameProblem(node) {
  const old = path.basename(node.dir);
  const slug = ws.slugOf(await vscode.window.showInputBox({ prompt: t('New name of the problem'), value: old }) || '');
  const dir = path.join(path.dirname(node.dir), slug);
  if (!slug || slug === old) return;
  if (fs.existsSync(dir)) {
    vscode.window.showErrorMessage(t('There is already a folder named {0}.', slug));
    return;
  }
  const kept = [];
  for (const file of ws.solutionsIn(node.dir)) kept.push([path.basename(file), await forget(file)]);
  if (!await move(node.dir, dir)) {
    for (const [name, state] of kept) recall(path.join(node.dir, name), state);
    refresh();
    return;
  }
  for (const [name, state] of kept) {
    const renamed = path.parse(name).name === old ? slug + path.extname(name) : name;
    if (renamed !== name && await move(path.join(dir, name), path.join(dir, renamed))) {
      fs.rmSync(path.join(dir, '.cp', old), { recursive: true, force: true });
      recall(path.join(dir, renamed), state);
    } else recall(path.join(dir, name), state);
  }
  target = target || solutionIn(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document);
  refresh();
}

async function renameSolution(node) {
  const old = ws.solutionOf(node.file);
  const base = path.basename(old.file);
  const ext = path.extname(base);
  const named = (value) => (ws.langOf(value) ? value : value + ext);
  const name = await askName({ prompt: t('New name of the solution'), value: base, valueSelection: [0, base.length - ext.length] }, (value) => named(value) !== base && fs.existsSync(path.join(old.dir, named(value))) && named(value));
  if (!name || named(name) === base) return;
  const file = path.join(old.dir, named(name));
  const shown = target && target.file === old.file;
  const state = await forget(old.file);
  const moved = await move(old.file, file);
  if (moved) fs.rmSync(old.outDir, { recursive: true, force: true });
  recall(moved ? file : old.file, state);
  if (shown) target = ws.solutionOf(moved ? file : old.file);
  refresh();
}

async function deleteSolution(node) {
  const s = ws.solutionOf(node.file);
  await forget(s.file);
  await vscode.workspace.fs.delete(vscode.Uri.file(s.file), { useTrash: true });
  fs.rmSync(s.outDir, { recursive: true, force: true });
  refresh();
}

function moveResults(dir, id, name) {
  for (const [file, state] of states) {
    if (path.dirname(file) !== dir || !state.results[id]) continue;
    if (name) state.results[name] = state.results[id];
    delete state.results[id];
  }
}

async function renameTest(dir, id) {
  const taken = (name) => name !== id && ws.TEST_FILES.some((ext) => fs.existsSync(path.join(dir, `${name}.${ext}`))) && name;
  const name = await askName({ prompt: t('New name of the test'), value: id }, taken);
  if (!name || name === id) return;
  for (const ext of ws.TEST_FILES) {
    const from = path.join(dir, `${id}.${ext}`);
    if (fs.existsSync(from) && !await move(from, path.join(dir, `${name}.${ext}`))) break;
  }
  if (!fs.existsSync(path.join(dir, `${id}.in`))) moveResults(dir, id, name);
  refresh();
}

async function deleteTest(dir, id) {
  for (const ext of ws.TEST_FILES) {
    const file = path.join(dir, `${id}.${ext}`);
    if (fs.existsSync(file)) await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
  }
  moveResults(dir, id);
  refresh();
}

function openTestFile(id, kind) {
  const file = path.join(target.dir, `${id}.${kind}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function reveal(file, line, column) {
  const full = path.isAbsolute(file) ? file : path.join(target.dir, file);
  if (!fs.existsSync(full)) return;
  const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, column - 1));
  await vscode.window.showTextDocument(vscode.Uri.file(full), { selection: new vscode.Range(position, position) });
}

const tree = {
  onDidChangeTreeData: changed.event,
  getChildren(node) {
    if (!node) return root() ? ws.problemsIn(root()).map((dir) => ({ kind: 'problem', dir })) : [];
    if (node.kind === 'problem') {
      return [
        ...ws.solutionsIn(node.dir).map((file) => ({ kind: 'solution', dir: node.dir, file })),
        ...ws.othersIn(node.dir).map((file) => ({ kind: 'file', label: path.basename(file), file })),
        ...ws.testIds(node.dir).map((id) => ({ kind: 'test', dir: node.dir, id })),
      ];
    }
    if (node.kind !== 'test') return [];
    return ws.TEST_FILES
      .map((ext) => ({ kind: 'file', label: `${node.id}.${ext}`, file: path.join(node.dir, `${node.id}.${ext}`) }))
      .filter((child) => fs.existsSync(child.file));
  },
  getTreeItem(node) {
    if (node.kind === 'problem') {
      const meta = ws.loadMeta(node.dir);
      const named = typeof meta.name === 'string' && meta.name;
      const item = new vscode.TreeItem(named || path.basename(node.dir), vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.dir;
      item.description = named ? path.basename(node.dir) : '';
      item.iconPath = new vscode.ThemeIcon('symbol-event');
      item.contextValue = 'problem';
      return item;
    }
    if (node.kind === 'solution') {
      const item = new vscode.TreeItem(path.basename(node.file));
      const state = states.get(node.file);
      const verdicts = state ? Object.values(sync(state, node.dir)).map((r) => r.verdict) : [];
      const answered = ws.testIds(node.dir).filter((id) => ws.answerOf(node.dir, id) !== undefined).length;
      item.id = node.file;
      item.resourceUri = vscode.Uri.file(node.file);
      item.iconPath = vscode.ThemeIcon.File;
      item.description = verdicts.length && answered ? t('{0}/{1} match', verdicts.filter((v) => v === 'match').length, answered) : '';
      item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
      item.contextValue = 'solution';
      return item;
    }
    if (node.kind === 'test') {
      const item = new vscode.TreeItem(t('Test {0}', node.id), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${node.dir}#${node.id}`;
      item.iconPath = new vscode.ThemeIcon('symbol-field');
      item.contextValue = 'test';
      return item;
    }
    const item = new vscode.TreeItem(node.label);
    item.resourceUri = vscode.Uri.file(node.file);
    item.iconPath = vscode.ThemeIcon.File;
    item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
    return item;
  },
};

const VIEW_STRINGS = ["Open a .cpp or .py file to run it here.", "Run", "Test", "{0} has not been run yet.", "Compilation failed", "Compiled with warnings", "Compiled", "failed", "warnings", "Running", "Finished", "Stopped", "Too much output", "Crashed", "Finished with an error", "End input (Ctrl+D)", "Stop (Ctrl+C)", "stopped", "{0} more are not shown", "Input for the program", "input ended", "Stopped: the program printed more than 16 MB", "Crashed ({0})", "Exit code {0}", "No answer to compare with", "Not run yet", "The output matches the answer", "The output differs from the answer", "not run yet", "{0} more are not shown; the whole output is compared with the answer", "output changed", "Copy and open problem", "More actions", "runtime error", "time limit", "memory limit", "output limit", "{0} KB", "{0} ms", "{0} MB", "# compile", "# test {0}"];

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const font = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'codicon.ttf')));
  return fs.readFileSync(path.join(__dirname, 'view.html'), 'utf8').replace(/{{nonce}}/g, nonce).replace(/{{font}}/g, String(font)).replace(/{{source}}/g, webview.cspSource)
    .replace('{{strings}}', JSON.stringify(Object.fromEntries(VIEW_STRINGS.map((text) => [text, t(text)]))).replace(/</g, '\\u003c'));
}

function receive(m) {
  if (m.type === 'ready') flush();
  const shown = target && { kind: 'solution', file: target.file };
  if (m.type === 'run') runTests(shown);
  if (m.type === 'single') run(shown);
  if (m.type === 'submit') submit();
  if (!target) return;
  if (m.type === 'goto') reveal(String(m.file), Number(m.line) || 1, Number(m.column) || 1);
  const live = active && active.file === target.file && active.state === 'running' ? active : undefined;
  if (live && m.type === 'stdin' && !live.closed) {
    const text = `${String(m.text)}\n`;
    live.child.stdin.write(text);
    live.input += text;
    say(live, 'in', text);
  }
  if (live && m.type === 'eof') {
    live.closed = true;
    live.child.stdin.end();
    update();
  }
  if (live && m.type === 'stop') stop();
}

function activate(context) {
  toolsRoot = path.join(context.globalStorageUri.fsPath, 'tools');
  fs.mkdirSync(toolsRoot, { recursive: true });
  terminalEnv = context.environmentVariableCollection;
  adopt();
  setup = doctor.create(context, toolsRoot, { cxx: cxxPath, flags: cxxFlags, python: pythonPath, env: toolEnv }, adopt);
  setup.start().catch(() => {});
  context.subscriptions.push(vscode.window.onDidChangeWindowState((window) => {
    const have = window.focused ? toolset.installed(toolsRoot) : undefined;
    if (have && (!managed || managed.dir !== have.dir)) adopt();
  }));
  const problems = vscode.window.createTreeView('eolympCode.problems', { treeDataProvider: tree });
  const describe = () => {
    if (!root()) return;
    const title = ws.readJson(path.join(root(), 'workspace.json')).title;
    problems.description = (typeof title === 'string' && title) || (path.basename(root()) === 'practice' ? '' : path.basename(root()));
  };
  describe();
  let settle;
  const later = () => {
    clearTimeout(settle);
    settle = setTimeout(() => { describe(); refresh(); }, 200);
  };
  const generated = (uri) => uri.fsPath.includes(`${path.sep}.cp${path.sep}`);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidCreate((uri) => { if (!generated(uri)) later(); });
  watcher.onDidDelete((uri) => { if (!generated(uri)) later(); });
  watcher.onDidChange((uri) => { if (/\.(in|answer|json)$/.test(uri.fsPath) && !generated(uri)) later(); });
  const testCommands = {
    openInput: (id) => openTestFile(id, 'in'),
    openAnswer: (id) => openTestFile(id, 'answer'),
    addAnswer: (id) => openTestFile(id, 'answer'),
    showDiff: (id) => showDiff(id),
    markCorrect: (id) => acceptOutput(id),
    debugTest: (id) => debugTest(id),
    renameTest: (id, dir) => renameTest(dir, id),
    deleteTest: (id, dir) => deleteTest(dir, id),
  };
  const commands = { run, runTests, stop, checkSetup, newProblem, newSolution, newTest, newFile, renameProblem, renameSolution, deleteSolution, addAsTest: keepSession };
  context.subscriptions.push(
    problems,
    watcher,
    vscode.workspace.registerTextDocumentContentProvider('eolymp-output', {
      onDidChange: outputs.event,
      provideTextDocumentContent(uri) {
        const { file, id, kind } = JSON.parse(uri.query);
        const r = states.has(file) && states.get(file).results[id];
        return (r && (kind === 'out' ? r.stdout : r.previous)) || '';
      },
    }),
    vscode.window.registerWebviewViewProvider('eolympCode.tests', {
      resolveWebviewView(v) {
        view = v;
        v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(__dirname)] };
        v.webview.html = html(v.webview);
        v.onDidDispose(() => { view = undefined; });
        v.webview.onDidReceiveMessage(receive);
      },
    }, { webviewOptions: { retainContextWhenHidden: true } }),
    ...Object.entries(testCommands).map(([name, action]) => vscode.commands.registerCommand(`eolympCode.${name}`, (item) => {
      if (item && item.kind === 'test') action(item.id, item.dir);
      else if (target && item && item.test) action(String(item.test), target.dir);
    })),
    ...Object.entries(commands).map(([name, action]) => vscode.commands.registerCommand(`eolympCode.${name}`, action)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      const s = solutionIn(editor && editor.document);
      if (!s || (target && s.file === target.file)) return;
      target = s;
      update();
    }),
  );
  target = solutionIn(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document);
  if (root()) vscode.commands.executeCommand('eolympCode.problems.focus');

  const failed = (err) => vscode.window.showErrorMessage(t('Could not read the problem sent by the browser: {0}', err.message));
  const server = companion.listen(config().get('companionPort'), (problem) => createProblem(problem.name, problem.tests, problem.meta).catch(failed), failed);
  context.subscriptions.push({ dispose: () => server.close() });
}

function deactivate() {
  runner.stopAll();
}

module.exports = { activate, deactivate };
