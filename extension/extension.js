const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ws = require('./workspace');
const runner = require('./runner');

const TEMPLATES = {
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n',
  py: 'import sys\ninput = sys.stdin.readline\n\n',
};
const CURSOR = { cpp: new vscode.Position(4, 4), py: new vscode.Position(3, 0) };
const t = vscode.l10n.t;

const states = new Map();
const changed = new vscode.EventEmitter();
let view;
let target;
let active;
let testing;
let pending;
let provided = {};
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

function judge(s, id, size, answer) {
  if (answer === undefined) return 'no answer';
  if (size > answer.length * 4 + (1 << 20)) return 'differs';
  return ws.verdictOf(ws.read(path.join(s.dir, `${id}.out`)), answer);
}

function sync(state, s) {
  const ids = new Set(ws.testIds(s.dir));
  for (const [id, r] of Object.entries(state.results)) {
    if (!ids.has(id)) delete state.results[id];
    else if (r.verdict !== 'running' && r.verdict !== 'runtime error') {
      const answer = ws.answerOf(s.dir, id);
      if (r.judged !== answer) r.verdict = judge(s, id, r.size, answer);
      r.judged = answer;
    }
  }
  return state.results;
}

function solutionIn(document) {
  return document && document.uri.scheme === 'file' ? ws.solutionOf(document.fileName) : undefined;
}

function toolDirs() {
  const dirs = path.isAbsolute(cxxPath()) ? [path.dirname(cxxPath())] : [];
  return provided.python ? [...dirs, path.dirname(provided.python)] : dirs;
}

function toolEnv() {
  const env = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
  env[key] = [...toolDirs(), env[key] || ''].join(path.delimiter);
  if (provided.cxx && cxxPath() === provided.cxx) Object.assign(env, provided.env);
  else if (config().get('includePath') || provided.include) env.CPLUS_INCLUDE_PATH = config().get('includePath') || provided.include;
  env.PYTHONUTF8 = '1';
  return env;
}

function cxxPath() {
  return config().inspect('cxx').globalValue || provided.cxx || config().get('cxx');
}

function cxxFlags() {
  return [...config().get('cxxFlags'), ...(provided.cxx && cxxPath() === provided.cxx ? provided.flags : [])];
}

function pythonPath() {
  return config().get('python') || provided.python || (process.platform === 'win32' ? 'python' : 'python3');
}

function shortName(command) {
  return path.basename(command).replace(/\.exe$/i, '');
}

function build(s, debug) {
  const built = building.then(async () => {
    const helper = vscode.extensions.getExtension('eolymp.eolymp-code-setup');
    if (helper) await helper.activate();
    return compile(s, debug);
  }).catch((err) => ({ ok: false, command: '', args: [], compile: '', log: t('Could not build: {0}', err.message), run: '' }));
  building = built;
  return built;
}

async function compile(s, debug) {
  const source = path.basename(s.file);
  if (s.lang === 'py') return { ok: true, missing: false, command: pythonPath(), args: [s.file], compile: '', log: '', run: `${shortName(pythonPath())} ${source}` };
  fs.mkdirSync(s.outDir, { recursive: true });
  const cxx = cxxPath();
  const exe = path.join(s.outDir, (debug ? 'debug' : 'run') + (process.platform === 'win32' ? '.exe' : ''));
  const flags = debug ? [...cxxFlags().filter((f) => !f.startsWith('-O')), '-g', '-O0'] : cxxFlags();
  const r = await runner.collect(cxx, [...flags, s.file, '-o', exe], { cwd: s.dir, env: toolEnv() });
  const shown = path.relative(s.dir, exe);
  return {
    ok: r.code === 0,
    missing: Boolean(r.missing),
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
    path: target ? target.file : '',
    tests: target ? ws.testIds(target.dir).map((id) => ({ id, answered: ws.answerOf(target.dir, id) !== undefined })) : [],
    results: state ? Object.fromEntries(Object.entries(sync(state, target)).map(([id, r]) => [id, { verdict: r.verdict, ms: r.ms, memory: r.memory, code: r.code, signal: r.signal, changed: r.changed, stdout: r.stdout, stderr: r.stderr, trimmed: r.trimmed }])) : {},
    compileError: state ? state.compileError : '',
    steps: state ? state.steps : null,
    setup: Boolean(provided.diagnose && state && state.steps && state.steps.missing),
    session: x ? { parts: x.parts, trimmed: x.size > x.shown, closed: x.closed, state: x.state, code: x.code, signal: x.signal, stopped: x.stopped, ms: x.ms, memory: x.memory, kept: x.kept, typed: x.input !== '' } : null,
  });
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
  session.size += text.length;
  const shown = text.slice(0, Math.max(0, runner.SHOWN - session.shown));
  if (!shown) return;
  session.shown += shown.length;
  const last = session.parts[session.parts.length - 1];
  if (last && last.kind === kind) last.text += shown;
  else session.parts.push({ kind, text: shown });
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
  const mine = { file: s.file, dir: s.dir, out: path.join(s.outDir, 'run.out'), parts: [], size: 0, shown: 0, state: 'compiling', input: '' };
  state.session = mine;
  active = mine;
  setBusy();
  update();
  const built = await build(s, false);
  if (active !== mine) return;
  state.steps = { compile: built.compile, run: built.run, ok: built.ok, missing: built.missing };
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
  fs.mkdirSync(s.outDir, { recursive: true });
  const file = fs.createWriteStream(mine.out);
  file.on('error', () => {});
  mine.child.stdout.pipe(file);
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
  fs.copyFileSync(x.out, path.join(x.dir, `${id}.out`));
  const stdout = x.parts.filter((part) => part.kind === 'out').map((part) => part.text).join('');
  state.results[id] = { verdict: 'no answer', ms: x.ms, memory: x.memory, stdout, size: fs.statSync(x.out).size, trimmed: x.size > x.shown };
  x.kept = id;
  refresh();
}

async function runTests(node) {
  const s = await prepare(node, t('Open a .cpp or .py file to test it.'));
  if (!s) return;
  const state = stateOf(s.file);
  const previous = { ...sync(state, s) };
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
  state.steps = { compile: built.compile, run: built.run, ok: built.ok, missing: built.missing };
  state.compileError = built.log;
  fs.mkdirSync(s.outDir, { recursive: true });
  for (const test of built.ok ? ws.loadTests(s.dir) : []) {
    if (job.cancelled) break;
    state.results[test.id] = { verdict: 'running' };
    update();
    const out = path.join(s.dir, `${test.id}.out`);
    for (const [file, other] of states) if (file !== s.file && path.dirname(file) === s.dir) delete other.results[test.id];
    const options = { cwd: s.dir, env: toolEnv(), python: pythonPath(), out, onStart: (child) => { job.child = child; if (job.cancelled) child.kill(); } };
    const r = await runner.collect(built.command, built.args, options, test.input);
    if (job.cancelled) {
      delete state.results[test.id];
      break;
    }
    const before = previous[test.id];
    state.results[test.id] = {
      verdict: r.code === 0 ? judge(s, test.id, r.size, test.answer) : 'runtime error',
      judged: test.answer,
      ms: r.ms,
      memory: r.memory,
      code: r.code,
      signal: r.signal,
      stdout: r.stdout,
      stderr: r.stderr,
      size: r.size,
      trimmed: r.trimmed,
      hash: r.hash,
      changed: Boolean(before && before.hash && before.hash !== r.hash),
    };
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
    Object.assign(stateOf(s.file), { compileError: built.log, steps: { compile: built.compile, run: built.run, ok: false, missing: built.missing } });
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
  const r = sync(stateOf(target.file), target)[id];
  if (!r || r.verdict === 'running' || r.verdict === 'runtime error') return;
  fs.copyFileSync(path.join(target.dir, `${id}.out`), path.join(target.dir, `${id}.answer`));
  refresh();
}

async function showDiff(id) {
  const s = target;
  const r = sync(stateOf(s.file), s)[id];
  const answer = path.join(s.dir, `${id}.answer`);
  if (!r || !fs.existsSync(answer)) {
    vscode.window.showInformationMessage(t('There is nothing to compare this output with yet.'));
    return;
  }
  const output = vscode.Uri.file(path.join(s.dir, `${id}.out`));
  await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(answer), output, t('Test {0}: answer ↔ output of {1}', id, path.basename(s.file)));
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

function askName(options, taken) {
  return vscode.window.showInputBox({
    ...options,
    validateInput: (value) => (ws.badName(value) ? t('This name cannot be used for a file.') : value.trim() && taken(value.trim()) ? t('The name {0} is already used.', taken(value.trim())) : undefined),
  }).then((value) => (value || '').trim());
}

async function newProblem() {
  const name = await vscode.window.showInputBox({ prompt: t('Name of the problem'), placeHolder: t('Leave empty to name it later') });
  if (name === undefined) return;
  if (!root()) {
    vscode.window.showErrorMessage(t('Open a folder first: problems are created in it.'));
    return;
  }
  let slug = ws.slugOf(name);
  for (let n = 1; !slug; n++) if (!fs.existsSync(path.join(root(), `untitled-${n}`))) slug = `untitled-${n}`;
  const dir = path.join(root(), slug);
  fs.mkdirSync(dir, { recursive: true });
  const lang = config().get('language');
  await openSolution(ws.solutionsIn(dir)[0] || path.join(dir, `${slug}.${lang}`), lang);
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
      if (fs.existsSync(path.join(dir, '.cp', old))) fs.renameSync(path.join(dir, '.cp', old), path.join(dir, '.cp', slug));
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
  if (moved && fs.existsSync(old.outDir)) fs.renameSync(old.outDir, ws.solutionOf(file).outDir);
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
      const item = new vscode.TreeItem(path.basename(node.dir), vscode.TreeItemCollapsibleState.Expanded);
      item.id = node.dir;
      item.iconPath = new vscode.ThemeIcon('symbol-event');
      item.contextValue = 'problem';
      return item;
    }
    if (node.kind === 'solution') {
      const item = new vscode.TreeItem(path.basename(node.file));
      const state = states.get(node.file);
      const verdicts = state ? Object.values(sync(state, ws.solutionOf(node.file))).map((r) => r.verdict) : [];
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

const VIEW_STRINGS = ["Open a .cpp or .py file to run it here.", "Run", "Test", "{0} has not been run yet.", "Compilation failed", "Compiled with warnings", "Compiled", "failed", "warnings", "Running", "Finished", "Stopped", "Crashed", "Finished with an error", "End input (Ctrl+D)", "Stop (Ctrl+C)", "stopped", "Input for the program", "input ended", "Crashed ({0})", "Exit code {0}", "No answer to compare with", "Not run yet", "The output matches the answer", "The output differs from the answer", "not run yet", "output changed", "Diagnostics", "More actions", "runtime error", "Output trimmed, open {0}", "{0} ms", "{0} MB", "# compile", "# test {0}"];

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
  if (m.type === 'setup' && provided.diagnose) provided.diagnose();
  if (!target) return;
  if (m.type === 'output' && (m.test === undefined || ws.testIds(target.dir).includes(m.test))) vscode.window.showTextDocument(vscode.Uri.file(m.test === undefined ? path.join(target.outDir, 'run.out') : path.join(target.dir, `${m.test}.out`)));
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
  const problems = vscode.window.createTreeView('eolympCode.problems', { treeDataProvider: tree });
  if (root() && path.basename(root()) !== 'practice') problems.description = path.basename(root());
  let settle;
  const later = () => {
    clearTimeout(settle);
    settle = setTimeout(refresh, 200);
  };
  const generated = (uri) => uri.fsPath.includes(`${path.sep}.cp${path.sep}`);
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidCreate((uri) => { if (!generated(uri)) later(); });
  watcher.onDidDelete((uri) => { if (!generated(uri)) later(); });
  watcher.onDidChange((uri) => { if (/\.(in|answer)$/.test(uri.fsPath) && !generated(uri)) later(); });
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
  const commands = { run, runTests, stop, newProblem, newSolution, newTest, newFile, renameProblem, renameSolution, deleteSolution, addAsTest: keepSession };
  context.subscriptions.push(
    problems,
    watcher,
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
  return {
    provide(tools) {
      provided = tools;
      runner.forget();
      update();
    },
  };
}

function deactivate() {
  runner.stopAll();
}

module.exports = { activate, deactivate };
