const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ws = require('./workspace');
const runner = require('./runner');
const judging = require('./judges');
const submission = require('./submission');
const { StringDecoder } = require('string_decoder');
const { PassThrough } = require('stream');
const net = require('net');
const childProcess = require('child_process');

const TEMPLATES = {
  cpp: '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    \n    return 0;\n}\n',
  py: 'import sys\ninput = sys.stdin.readline\n\n',
};
const CURSOR = { cpp: new vscode.Position(4, 4), py: new vscode.Position(3, 0) };
const t = vscode.l10n.t;

const states = new Map();
const used = new Map();
const changed = new vscode.EventEmitter();
let view;
let problems;
let drawn;
let tools = {};
let opening;
let clip;
let target;
let active;
let testing;
let pending;
let provided = {};
let building = Promise.resolve();
let starting = false;
let launched = 0;
const launches = new Map();

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
  env.PYTHON_COLORS = '0';
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
    const providers = vscode.extensions.all.filter((extension) => extension.packageJSON.eolympCode && extension.packageJSON.eolympCode.toolchain);
    await Promise.allSettled(providers.map((extension) => extension.activate()));
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
  const shown = (id) => !state || state.only === undefined || state.only === id;
  view.webview.postMessage({
    file: target ? path.basename(target.file) : '',
    path: target ? target.file : '',
    root: target && vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.file)) ? vscode.workspace.getWorkspaceFolder(vscode.Uri.file(target.file)).uri.fsPath : '',
    tests: target ? ws.testIds(target.dir).filter(shown).map((id) => ({ id, answered: ws.answerOf(target.dir, id) !== undefined })) : [],
    results: state ? Object.fromEntries(Object.entries(sync(state, target)).filter(([id]) => shown(id)).map(([id, r]) => [id, { verdict: r.verdict, ms: r.ms, memory: r.memory, code: r.code, signal: r.signal, changed: r.changed, stdout: r.stdout, stderr: r.stderr, trimmed: r.trimmed }])) : {},
    compileError: state ? state.compileError : '',
    steps: state ? state.steps : null,
    last: state ? state.last : undefined,
    only: Boolean(state && state.only !== undefined),
    testing: Boolean(testing && target && testing.file === target.file),
    setup: Boolean(provided.diagnose && state && state.steps && state.steps.missing),
    session: x ? { parts: x.parts, trimmed: x.size > x.shown, closed: x.closed, state: x.state, code: x.code, signal: x.signal, stopped: x.stopped, ms: x.ms, memory: x.memory, kept: x.kept, typed: x.input !== '', debug: x.debug } : null,
  });
}

function update() {
  if (!pending) pending = setTimeout(flush, 40);
}

function scoreOf(file) {
  const state = states.get(file);
  const verdicts = state ? Object.values(sync(state, ws.solutionOf(file))).map((r) => r.verdict) : [];
  const answered = ws.testIds(path.dirname(file)).filter((id) => ws.answerOf(path.dirname(file), id) !== undefined).length;
  return verdicts.length && answered ? t('{0}/{1} match', verdicts.filter((v) => v === 'match').length, answered) : '';
}

function outline(node) {
  return tree.getChildren(node).map((child) => [child.kind, child.file || child.dir, child.id, child.kind === 'solution' ? scoreOf(child.file) : '', outline(child)]);
}

function refresh() {
  const now = JSON.stringify(outline());
  if (now !== drawn) changed.fire();
  drawn = now;
  update();
}

function setBusy() {
  vscode.commands.executeCommand('setContext', 'eolympCode.running', Boolean(testing || (active && active.state !== 'finished')));
}

function stopActive() {
  if (!active) return Promise.resolve();
  const session = active;
  stateOf(session.file).session = null;
  active = undefined;
  setBusy();
  if (!session.halt) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    session.ended.then(() => { clearTimeout(timer); resolve(); });
    session.halt();
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

async function prepare(from, missing) {
  const node = from === 'focused' ? chosen()[0] : from;
  const picked = node && node.kind === 'solution';
  const shown = from instanceof vscode.Uri ? await vscode.workspace.openTextDocument(from) : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  let document = picked ? await vscode.workspace.openTextDocument(node.file) : shown;
  let s = solutionIn(document);
  if (!s && target && fs.existsSync(target.file)) {
    s = target;
    document = await vscode.workspace.openTextDocument(s.file);
  }
  if (!s) {
    vscode.window.showInformationMessage(missing);
    return undefined;
  }
  if (testing || starting) return undefined;
  starting = true;
  try {
    if (picked && !node.quiet) await vscode.window.showTextDocument(document);
    await document.save();
    await stopActive();
    target = s;
    used.set(s.dir, s.file);
    await vscode.commands.executeCommand('eolympCode.tests.focus');
  } finally {
    starting = false;
  }
  return s;
}

async function run(node) {
  const editor = vscode.window.activeTextEditor;
  const open = editor && editor.document.uri.scheme === 'file' ? nodeOf(editor.document.fileName) : undefined;
  const picked = node === 'focused' ? chosen()[0] : node || open;
  if (picked && (picked.kind === 'test' || picked.kind === 'testFile')) {
    await runTest(picked);
    return;
  }
  const s = await prepare(node, t('Open a .cpp or .py file to run it.'));
  if (!s) return;
  const state = stateOf(s.file);
  const mine = { file: s.file, dir: s.dir, out: path.join(s.outDir, 'run.out'), parts: [], size: 0, shown: 0, state: 'compiling', input: '' };
  state.session = mine;
  state.last = 'run';
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
  const child = runner.start(wrapped.command, wrapped.args, { cwd: s.dir, env: toolEnv() });
  child.stdin.on('error', () => {});
  Object.assign(mine, { stdin: child.stdin, halt: () => child.kill(), ended: new Promise((resolve) => child.once('close', resolve)) });
  fs.mkdirSync(s.outDir, { recursive: true });
  const file = fs.createWriteStream(mine.out);
  file.on('error', () => {});
  child.stdout.pipe(file);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => say(mine, 'out', d));
  child.stderr.on('data', (d) => say(mine, 'err', d));
  const finish = (code, signal, text) => {
    if (mine.state === 'finished') return;
    const r = wrapped.finish({ code, signal, ms: Date.now() - started });
    Object.assign(mine, { state: 'finished', stdin: undefined, halt: undefined, code: r.code, signal: r.signal, ms: r.ms, memory: r.memory });
    if (text || r.failure) say(mine, 'err', text || `${r.failure}\n`);
    if (active === mine) active = undefined;
    setBusy();
    update();
  };
  child.on('error', (err) => finish(-1, undefined, `${err.message}\n`));
  child.on('close', (code, signal) => finish(code, signal));
  update();
}

function keepSession() {
  const state = target && stateOf(target.file);
  const x = state && state.session;
  if (!x || x.state !== 'finished' || x.kept) return;
  const id = ws.nextTest(x.dir);
  ws.saveTest(x.dir, id, x.input);
  fs.copyFileSync(x.out, path.join(x.dir, `${id}.out`));
  const stdout = x.parts.filter((part) => part.kind === 'out').map((part) => part.text).join('');
  state.results[id] = { verdict: 'no answer', ms: x.ms, memory: x.memory, stdout, size: fs.statSync(x.out).size, trimmed: x.size > x.shown };
  x.kept = id;
  refresh();
}

function runTests(node) {
  return testWith(node);
}

function solutionFor(dir) {
  const last = target && target.dir === dir ? target.file : used.get(dir);
  return last && fs.existsSync(last) ? last : ws.solutionsIn(dir)[0];
}

async function runTest(from) {
  const editor = vscode.window.activeTextEditor;
  const open = editor && editor.document.uri.scheme === 'file' ? nodeOf(editor.document.fileName) : undefined;
  const node = from instanceof vscode.Uri ? nodeOf(from.fsPath) : from || (open && open.kind === 'testFile' ? open : chosen()[0]);
  if (!node || (node.kind !== 'test' && node.kind !== 'testFile')) {
    if (from instanceof vscode.Uri) vscode.window.showInformationMessage(t('This file is not a test of a problem.'));
    return;
  }
  const file = solutionFor(node.dir);
  if (!file) {
    vscode.window.showInformationMessage(t('This problem has no solution to run.'));
    return;
  }
  await testWith({ kind: 'solution', file, quiet: true }, node.id);
}

async function testWith(node, only) {
  const s = await prepare(node, t('Open a .cpp or .py file to test it.'));
  if (!s) return;
  for (const document of vscode.workspace.textDocuments) {
    if (document.isDirty && document.uri.scheme === 'file' && path.dirname(document.fileName) === s.dir && /\.(in|answer)$/.test(document.fileName)) await document.save();
  }
  const state = stateOf(s.file);
  const previous = { ...sync(state, s) };
  const job = { cancelled: false, file: s.file };
  state.results = only === undefined ? {} : { ...previous };
  delete state.results[only];
  state.only = only;
  state.steps = null;
  state.compileError = '';
  state.session = null;
  state.last = 'test';
  testing = job;
  setBusy();
  update();
  try {
    await runAll(s, state, previous, job, only);
  } catch (err) {
    state.compileError = t('Could not run the tests: {0}', err.message);
  } finally {
    if (only !== undefined && job.cancelled && !state.results[only] && previous[only]) state.results[only] = previous[only];
    testing = undefined;
    setBusy();
    refresh();
  }
}

async function runAll(s, state, previous, job, only) {
  const built = await build(s, false);
  state.steps = { compile: built.compile, run: built.run, ok: built.ok, missing: built.missing };
  state.compileError = built.log;
  if (!built.ok) state.results = {};
  for (const test of built.ok ? ws.loadTests(s.dir).filter((item) => only === undefined || item.id === only) : []) {
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
  } else if (active && active.halt) {
    active.stopped = true;
    active.halt();
  }
}

function debug(from) {
  const editor = vscode.window.activeTextEditor;
  let node = from instanceof vscode.Uri ? nodeOf(from.fsPath) : from === 'focused' ? chosen()[0] : from;
  if (node && node.test !== undefined && target) node = { kind: 'test', dir: target.dir, id: String(node.test) };
  if (!node && editor && editor.document.uri.scheme === 'file') node = nodeOf(editor.document.fileName);
  if (!node || (node.kind !== 'test' && node.kind !== 'testFile')) return debugWith(node && node.kind === 'solution' ? node : undefined, {});
  const file = solutionFor(node.dir);
  if (!file) {
    vscode.window.showInformationMessage(t('This problem has no solution to run.'));
    return undefined;
  }
  return debugWith({ kind: 'solution', file, quiet: true }, { test: node.id });
}

async function debugWith(node, input) {
  if (vscode.debug.activeDebugSession) return;
  const s = await prepare(node, t('Open a .cpp or .py file to debug it.'));
  if (!s) return;
  const state = stateOf(s.file);
  const token = ++launched;
  const typing = input.test === undefined && input.typed === undefined;
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\eolymp-code-${process.pid}-${token}` : path.join(s.outDir, `debug-${token}.in`);
  const stdin = typing ? pipe : input.test === undefined ? path.join(s.outDir, 'run.in') : path.join(s.dir, `${input.test}.in`);
  const uri = vscode.Uri.file(s.file);
  let ended;
  let server;
  let timer;
  let pumps = [];
  let entry = [];
  const mine = { file: s.file, dir: s.dir, out: path.join(s.outDir, 'run.out'), err: path.join(s.outDir, 'run.err'), parts: [], size: 0, shown: 0, state: 'compiling', input: input.typed || '', test: input.test, closed: !typing, debug: true, ended: new Promise((resolve) => { ended = resolve; }) };
  mine.finish = () => {
    if (mine.state === 'finished') return;
    clearInterval(timer);
    pumps.forEach((pump) => pump());
    if (server) server.close();
    else if (typing) fs.rm(pipe, { force: true }, () => {});
    else if (mine.stdin) fs.open(pipe, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK, (err, fd) => { if (!err) fs.close(fd, () => {}); });
    if (mine.stdin) mine.stdin.destroy();
    vscode.debug.removeBreakpoints(entry);
    launches.delete(token);
    Object.assign(mine, { state: 'finished', stdin: undefined, halt: undefined, stopped: mine.stopped || mine.code === undefined });
    if (active === mine) active = undefined;
    setBusy();
    update();
    ended();
  };
  state.session = mine;
  state.last = 'run';
  active = mine;
  setBusy();
  update();
  const document = await vscode.workspace.openTextDocument(uri);
  const built = await build(s, true);
  if (active !== mine) return;
  state.steps = { compile: built.compile, run: input.test === undefined ? built.run : `${built.run} < ${input.test}.in`, ok: built.ok, missing: built.missing };
  state.compileError = built.log;
  if (!built.ok) {
    await stopActive();
    update();
    return;
  }
  let started = false;
  try {
    fs.mkdirSync(s.outDir, { recursive: true });
    if (input.typed !== undefined) fs.writeFileSync(stdin, input.typed);
    fs.writeFileSync(mine.out, '');
    fs.writeFileSync(mine.err, '');
    if (typing && process.platform === 'win32') {
      mine.stdin = new PassThrough();
      server = net.createServer((socket) => { socket.on('error', () => {}); mine.stdin.pipe(socket); });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
    } else if (typing) {
      fs.rmSync(pipe, { force: true });
      childProcess.execFileSync('mkfifo', [pipe]);
      mine.stdin = fs.createWriteStream(pipe);
      mine.stdin.on('error', () => {});
    }
    if (active !== mine) {
      mine.finish();
      return;
    }
    if (input.typed) say(mine, 'in', input.typed.endsWith('\n') ? input.typed : `${input.typed}\n`);
    pumps = [[mine.out, 'out'], [mine.err, 'err']].map(([file, kind]) => {
      const decoder = new StringDecoder('utf8');
      let at = 0;
      return () => {
        const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        while (size > at && mine.shown < runner.SHOWN) {
          const chunk = Buffer.alloc(Math.min(size - at, runner.SHOWN));
          const fd = fs.openSync(file, 'r');
          const read = fs.readSync(fd, chunk, 0, chunk.length, at);
          fs.closeSync(fd);
          if (!read) break;
          at += read;
          say(mine, kind, decoder.write(chunk.subarray(0, read)));
        }
        if (mine.shown < runner.SHOWN) return;
        mine.size += Math.max(0, size - at);
        at = Math.max(at, size);
      };
    });
    timer = setInterval(() => pumps.forEach((pump) => pump()), 100);
    const hasBreakpoint = vscode.debug.breakpoints.some((b) => b instanceof vscode.SourceBreakpoint && b.location.uri.fsPath === s.file);
    const first = document.getText().split('\n').findIndex((line) => line.trim() && !line.trim().startsWith('#'));
    entry = s.lang === 'cpp' || hasBreakpoint || first < 0 ? [] : [new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(first, 0)))];
    vscode.debug.addBreakpoints(entry);
    const quoted = (text) => `"${text.replace(/[\\"]/g, '\\$&')}"`;
    const env = toolEnv();
    const added = Object.keys(env).filter((key) => env[key] !== process.env[key]);
    const common = { request: 'launch', name: input.test === undefined ? t('Run') : t('Test {0}', input.test), cwd: s.dir, internalConsoleOptions: 'neverOpen', eolympCode: token };
    mine.halt = () => {
      mine.stopped = true;
      if (mine.session) vscode.debug.stopDebugging(mine.session);
    };
    mine.state = 'running';
    launches.set(token, mine);
    update();
    started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri), s.lang === 'cpp' ? {
      ...common,
      type: 'lldb',
      program: built.command,
      terminal: 'console',
      processCreateCommands: [`process launch -i ${quoted(stdin)} -o ${quoted(mine.out)} -e ${quoted(mine.err)} -w ${quoted(s.dir)} ${added.map((key) => `-E ${quoted(`${key}=${env[key]}`)}`).join(' ')}`],
      preRunCommands: hasBreakpoint ? [] : ['breakpoint set --name main --one-shot true'],
    } : {
      ...common,
      type: 'debugpy',
      python: built.command,
      program: path.join(__dirname, 'debug.py'),
      args: [s.file, stdin, mine.out, mine.err],
      env: { ...Object.fromEntries(added.map((key) => [key, env[key]])), PYDEVD_DISABLE_FILE_VALIDATION: '1' },
      console: 'internalConsole',
      rules: [{ path: path.join(__dirname, '**'), include: false }],
    });
  } catch (err) {
    say(mine, 'err', `${err.message}\n`);
  }
  if (!started) mine.finish();
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

async function openSolution(file, lang, given) {
  const fresh = !fs.existsSync(file);
  if (fresh) fs.writeFileSync(file, given || TEMPLATES[lang]);
  target = ws.solutionOf(file);
  refresh();
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document);
  if (fresh && !given) editor.selection = new vscode.Selection(CURSOR[lang], CURSOR[lang]);
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

async function createProblem(name, templates = {}) {
  if (!root()) {
    vscode.window.showErrorMessage(t('Open a folder first: problems are created in it.'));
    return undefined;
  }
  let slug = ws.slugOf(name);
  for (let n = 1; !slug; n++) if (!fs.existsSync(path.join(root(), `untitled-${n}`))) slug = `untitled-${n}`;
  const dir = path.join(root(), slug);
  fs.mkdirSync(dir, { recursive: true });
  const lang = config().get('language');
  await openSolution(ws.solutionsIn(dir)[0] || path.join(dir, `${slug}.${lang}`), lang, templates[lang]);
  return dir;
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
  refresh();
  await vscode.window.showTextDocument(vscode.Uri.file(file));
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
  if (state) states.set(file, { ...state, steps: null, session: null, only: undefined });
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
      if (fs.existsSync(path.join(dir, '.build', old))) fs.renameSync(path.join(dir, '.build', old), path.join(dir, '.build', slug));
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

async function renameFile(node) {
  const base = path.basename(node.file);
  const name = await askName({ prompt: t('New name of the file'), value: base, valueSelection: [0, path.parse(base).name.length] }, (value) => value !== base && fs.existsSync(path.join(node.dir, value)) && value);
  if (name && name !== base && await move(node.file, path.join(node.dir, name))) refresh();
}

function testName(id) {
  return /^\d+$/.test(id) ? t('Test {0}', id) : t('Test "{0}"', id);
}

function chosen(node, nodes) {
  if (nodes && nodes.length) return nodes;
  if (node) return [node];
  const focused = problems.activeItem;
  return focused && !problems.selection.includes(focused) ? [focused] : problems.selection;
}

function rename(node) {
  const picked = chosen(node).length === 1 ? chosen(node)[0] : undefined;
  if (!picked) return undefined;
  if (picked.kind === 'problem') return renameProblem(picked);
  if (picked.kind === 'solution') return renameSolution(picked);
  if (picked.kind === 'file') return renameFile(picked);
  return renameTest(picked.dir, picked.id);
}

function whole(n) {
  return n.kind === 'test' || (n.kind === 'testFile' && n.file.endsWith('.in'));
}

async function discard(items) {
  const edit = new vscode.WorkspaceEdit();
  const solutions = [];
  for (const n of items) {
    if (n.kind === 'problem') {
      solutions.push(...ws.solutionsIn(n.dir));
      edit.deleteFile(vscode.Uri.file(n.dir), { recursive: true, folder: true });
      continue;
    }
    if (n.kind === 'solution') solutions.push(n.file);
    for (const file of whole(n) ? ws.TEST_FILES.map((ext) => path.join(n.dir, `${n.id}.${ext}`)) : [n.file]) edit.deleteFile(vscode.Uri.file(file), { ignoreIfNotExists: true, maxSize: 5000000 });
  }
  const kept = [];
  for (const file of solutions) kept.push([file, await forget(file)]);
  if (!await vscode.workspace.applyEdit(edit)) vscode.window.showErrorMessage(t('Could not delete the selected items.'));
  for (const [file, state] of kept) {
    if (fs.existsSync(file)) recall(file, state);
    else fs.rmSync(ws.solutionOf(file).outDir, { recursive: true, force: true });
  }
  for (const n of items) if (whole(n) && !fs.existsSync(path.join(n.dir, `${n.id}.in`))) moveResults(n.dir, n.id);
  refresh();
}

async function remove(node, nodes) {
  const picked = chosen(node, nodes);
  const items = picked.filter((n) => {
    if (n.kind !== 'problem' && picked.some((p) => p.kind === 'problem' && p.dir === n.dir)) return false;
    return n.kind !== 'testFile' || !picked.some((p) => p !== n && p.dir === n.dir && p.id === n.id && whole(p));
  });
  if (!items.length) return;
  const names = items.map((n) => (n.kind === 'problem' ? path.basename(n.dir) : whole(n) ? testName(n.id) : path.basename(n.file)));
  const message = items.length === 1 ? t("Are you sure you want to delete '{0}'?", names[0]) : t('Are you sure you want to delete these {0} items?', items.length);
  const button = process.platform === 'win32' ? t('Move to Recycle Bin') : t('Move to Trash');
  if (await vscode.window.showWarningMessage(message, { modal: true, detail: items.length === 1 ? undefined : names.join('\n') }, button) !== button) return;
  await discard(items);
}

function copy(node, nodes, cut) {
  const picked = chosen(node, nodes);
  const items = picked.filter((n) => !cut || n.kind !== 'problem');
  if (!items.length) return;
  clip = { items, cut };
  vscode.commands.executeCommand('setContext', 'eolympCode.canPaste', true);
}

async function paste(node) {
  const at = node || problems.activeItem || problems.selection[0];
  if (!clip || !root()) return;
  const edit = new vscode.WorkspaceEdit();
  const taken = new Set();
  const free = (dir, name, mark) => {
    const { name: stem, ext } = path.parse(name);
    for (let n = 0; ; n += 1) {
      const candidate = n === 0 ? name : `${stem}${mark}${n > 1 ? `${mark === '-copy' ? '-' : ' '}${n}` : ''}${ext}`;
      const file = path.join(dir, candidate);
      if (!fs.existsSync(file) && !taken.has(file)) {
        taken.add(file);
        return file;
      }
    }
  };
  const put = (from, to) => {
    if (clip.cut) edit.renameFile(vscode.Uri.file(from), vscode.Uri.file(to));
    else edit.createFile(vscode.Uri.file(to), { contents: fs.readFileSync(from) });
  };
  for (const n of clip.items) {
    if (n.kind === 'problem') {
      const old = path.basename(n.dir);
      const dir = free(root(), old, '-copy');
      for (const entry of fs.readdirSync(n.dir, { recursive: true, withFileTypes: true })) {
        const inside = path.relative(n.dir, path.join(entry.parentPath, entry.name));
        if (entry.isDirectory() || inside.startsWith('.build')) continue;
        const own = !inside.includes(path.sep) && path.parse(inside).name === old && ws.langOf(inside);
        put(path.join(n.dir, inside), path.join(dir, own ? path.basename(dir) + path.extname(inside) : inside));
      }
      continue;
    }
    if (!at || (n.file && !fs.existsSync(n.file)) || (clip.cut && at.dir === n.dir)) continue;
    if (n.kind === 'test' || (n.kind === 'testFile' && n.file.endsWith('.in'))) {
      const numbers = [...ws.testIds(at.dir), ...[...taken].filter((file) => path.dirname(file) === at.dir).map((file) => path.parse(file).name)].map(Number).filter(Number.isInteger);
      const used = fs.existsSync(path.join(at.dir, `${n.id}.in`)) || taken.has(path.join(at.dir, `${n.id}.in`));
      const id = used ? String(Math.max(0, ...numbers) + 1) : n.id;
      taken.add(path.join(at.dir, `${id}.in`));
      for (const ext of clip.cut ? ws.TEST_FILES : ['in', 'answer']) if (fs.existsSync(path.join(n.dir, `${n.id}.${ext}`))) put(path.join(n.dir, `${n.id}.${ext}`), path.join(at.dir, `${id}.${ext}`));
      if (clip.cut) moveResults(n.dir, n.id);
    } else {
      if (clip.cut && n.kind === 'solution') await forget(n.file);
      put(n.file, free(at.dir, path.basename(n.file), ' copy'));
    }
  }
  await vscode.workspace.applyEdit(edit);
  if (clip.cut) {
    clip = undefined;
    vscode.commands.executeCommand('setContext', 'eolympCode.canPaste', false);
  }
  refresh();
}

async function openTest(node) {
  const file = path.join(node.dir, `${node.id}.in`);
  opening = file;
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(file), { preserveFocus: true });
  } finally {
    if (opening === file) opening = undefined;
  }
}

function nodeOf(file) {
  const dir = path.dirname(file);
  const label = path.basename(file);
  if (!root() || path.dirname(dir) !== root() || label.startsWith('.')) return undefined;
  if (ws.langOf(file)) return { kind: 'solution', dir, file };
  const found = /^(.*)\.(in|out|answer)$/.exec(label);
  if (found && ws.testIds(dir).includes(found[1])) return { kind: 'testFile', dir, id: found[1], label, file };
  return { kind: 'file', dir, label, file };
}

function show(editor) {
  const node = editor && editor.document.uri.scheme === 'file' ? nodeOf(editor.document.fileName) : undefined;
  if (!node || node.file === opening || !problems.visible || problems.selection.some((n) => n.file === node.file || (n.kind === 'test' && n.dir === node.dir && n.id === node.id))) return;
  problems.reveal(node, { select: true, focus: false }).then(undefined, () => {});
}

function moveResults(dir, id, name) {
  for (const [file, state] of states) {
    if (path.dirname(file) !== dir) continue;
    if (state.only === id) state.only = name;
    if (!state.results[id]) continue;
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

function deleteTest(dir, id) {
  return discard([{ kind: 'test', dir, id }]);
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
        ...ws.testIds(node.dir).map((id) => ({ kind: 'test', dir: node.dir, id })),
        ...ws.solutionsIn(node.dir).map((file) => ({ kind: 'solution', dir: node.dir, file })),
        ...ws.othersIn(node.dir).map((file) => ({ kind: 'file', dir: node.dir, label: path.basename(file), file })),
      ];
    }
    if (node.kind !== 'test') return [];
    return ws.TEST_FILES
      .map((ext) => ({ kind: 'testFile', dir: node.dir, id: node.id, label: `${node.id}.${ext}`, file: path.join(node.dir, `${node.id}.${ext}`) }))
      .filter((child) => fs.existsSync(child.file));
  },
  getParent(node) {
    if (node.kind === 'problem') return undefined;
    return node.kind === 'testFile' ? { kind: 'test', dir: node.dir, id: node.id } : { kind: 'problem', dir: node.dir };
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
      item.id = node.file;
      item.resourceUri = vscode.Uri.file(node.file);
      item.iconPath = vscode.ThemeIcon.File;
      item.description = scoreOf(node.file);
      item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
      item.contextValue = 'solution';
      return item;
    }
    if (node.kind === 'test') {
      const item = new vscode.TreeItem(testName(node.id), vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${node.dir}#${node.id}`;
      item.iconPath = { dark: vscode.Uri.file(path.join(__dirname, 'test-dark.svg')), light: vscode.Uri.file(path.join(__dirname, 'test-light.svg')) };
      item.command = { command: 'eolympCode.openTest', title: 'Open', arguments: [node] };
      item.contextValue = 'test';
      return item;
    }
    const item = new vscode.TreeItem(node.label);
    item.id = node.file;
    item.contextValue = node.kind;
    item.resourceUri = vscode.Uri.file(node.file);
    item.iconPath = vscode.ThemeIcon.File;
    item.command = { command: 'vscode.open', title: 'Open', arguments: [item.resourceUri] };
    return item;
  },
};

const VIEW_STRINGS = ["Open a .cpp or .py file to run it here.", "Run", "Compilation failed", "Compiled with warnings", "Compiled", "failed", "warnings", "Running", "Finished", "Stopped", "Crashed", "Finished with an error", "stopped", "Input for the program", "input ended", "Crashed ({0})", "Exit code {0}", "No answer to compare with", "The output matches the answer", "The output differs from the answer", "output changed", "Diagnostics", "More actions", "runtime error", "Output trimmed, open {0}", "{0} ms", "{0} MB", "# compile", "# test {0}", "{0}/{1} match", "Testing {0} on your computer", "Running {0} on your computer"];

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const font = webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, 'codicon.ttf')));
  return fs.readFileSync(path.join(__dirname, 'view.html'), 'utf8').replace(/{{nonce}}/g, nonce).replace(/{{font}}/g, String(font)).replace(/{{source}}/g, webview.cspSource)
    .replace('{{strings}}', JSON.stringify(Object.fromEntries(VIEW_STRINGS.map((text) => [text, t(text)]))).replace(/</g, '\\u003c'));
}

function receive(m) {
  if (m.type === 'ready') flush();
  if (m.type === 'tools') {
    tools = m;
    vscode.commands.executeCommand('setContext', 'eolympCode.console.idle', !m.hidden && !m.busy);
    vscode.commands.executeCommand('setContext', 'eolympCode.console.busy', !m.hidden && m.busy);
    vscode.commands.executeCommand('setContext', 'eolympCode.console.typing', !m.hidden && m.typing);
    vscode.commands.executeCommand('setContext', 'eolympCode.console.debug', !m.hidden && m.debug);
  }
  const shown = target && { kind: 'solution', file: target.file };
  if (m.type === 'run') runTests(shown);
  if (m.type === 'rerun' && target) testWith({ ...shown, quiet: true }, stateOf(target.file).only);
  const state = target && stateOf(target.file);
  const x = state && state.session;
  const last = !state ? undefined : m.only ? state.only : x ? x.test : undefined;
  const test = last !== undefined && ws.testIds(target.dir).includes(last) ? last : undefined;
  if (m.type === 'single' && test !== undefined) testWith({ ...shown, quiet: true }, test);
  else if (m.type === 'single') run(shown);
  if (m.type === 'debug' && test !== undefined) debugWith({ ...shown, quiet: true }, { test });
  else if (m.type === 'debug' && x && x.state === 'finished') debugWith({ ...shown, quiet: true }, x.input ? { typed: x.input } : {});
  if (m.type === 'setup' && provided.diagnose) provided.diagnose();
  if (!target) return;
  if (m.type === 'output' && (m.test === undefined || ws.testIds(target.dir).includes(m.test))) vscode.window.showTextDocument(vscode.Uri.file(m.test === undefined ? path.join(target.outDir, 'run.out') : path.join(target.dir, `${m.test}.out`)));
  if (m.type === 'open') vscode.window.showTextDocument(vscode.Uri.file(target.file));
  if (m.type === 'goto') reveal(String(m.file), Number(m.line) || 1, Number(m.column) || 1);
  const live = active && active.file === target.file && active.state === 'running' ? active : undefined;
  if (live && m.type === 'stdin' && !live.closed) {
    const text = `${String(m.text)}\n`;
    live.stdin.write(text);
    live.input += text;
    say(live, 'in', text);
  }
  if (live && m.type === 'eof') {
    live.closed = true;
    live.stdin.end();
    update();
  }
  if (m.type === 'stop' && ((active && active.file === target.file) || (testing && testing.file === target.file))) stop();
}

function activate(context) {
  problems = vscode.window.createTreeView('eolympCode.problems', { treeDataProvider: tree, canSelectMany: true, showCollapseAll: true });
  if (root() && path.basename(root()) !== 'practice') problems.description = path.basename(root());
  let settle;
  const later = () => {
    clearTimeout(settle);
    settle = setTimeout(refresh, 200);
  };
  const generated = (uri) => uri.fsPath.includes(`${path.sep}.build${path.sep}`);
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
    renameTest: (id, dir) => renameTest(dir, id),
    deleteTest: (id, dir) => deleteTest(dir, id),
  };
  const judges = judging.create(createProblem, refresh);
  const commands = { run, runTests, runTest, debug, openTest, stop, newProblem, findProblem: judges.find, submit: judges.submit, consoleRerun: () => receive({ type: tools.tested ? 'rerun' : 'single' }), consoleDebug: () => receive({ type: 'debug', only: tools.tested }), consoleEndInput: () => receive({ type: 'eof' }), consoleStop: () => receive({ type: 'stop' }), newSolution, newTest, newFile, rename, delete: remove, copy: (node, nodes) => copy(node, nodes, false), cut: (node, nodes) => copy(node, nodes, true), paste, addAsTest: keepSession };
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterTrackerFactory('*', {
      createDebugAdapterTracker(session) {
        const mine = launches.get(session.configuration.eolympCode);
        if (!mine || session.parentSession) return undefined;
        return {
          onWillReceiveMessage: (m) => { if ((m.command === 'disconnect' || m.command === 'terminate') && mine.code === undefined) mine.stopped = true; },
          onDidSendMessage: (m) => {
            if (m.type !== 'event') return;
            if (m.event === 'exited') mine.code = m.body.exitCode;
            if (m.event !== 'stopped' || m.body.reason !== 'step' || session.type !== 'lldb') return;
            session.customRequest('stackTrace', { threadId: m.body.threadId, startFrame: 0, levels: 1 }).then((trace) => {
              const frame = trace.stackFrames[0];
              if (!frame || !frame.source || !frame.source.path || frame.source.sourceReference) return session.customRequest('continue', { threadId: m.body.threadId });
              return undefined;
            }).then(undefined, () => {});
          },
        };
      },
    }),
    vscode.debug.onDidStartDebugSession((session) => {
      const mine = launches.get(session.configuration.eolympCode);
      if (!mine || session.parentSession) return;
      mine.session = session;
      if (mine.stopped) vscode.debug.stopDebugging(session);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      const mine = launches.get(session.configuration.eolympCode);
      if (mine && !session.parentSession) mine.finish();
    }),
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
    problems.onDidChangeVisibility(() => show(vscode.window.activeTextEditor)),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      judges.mark();
      show(editor);
      const s = solutionIn(editor && editor.document);
      if (!s || (target && s.file === target.file)) return;
      target = s;
      update();
    }),
  );
  submission.register(context);
  target = solutionIn(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document);
  show(vscode.window.activeTextEditor);
  return {
    registerJudge: judges.register,
    registerToolchain(toolchain = {}) {
      const use = (tools) => {
        provided = tools;
        runner.forget();
        update();
      };
      use(toolchain);
      return new vscode.Disposable(() => {
        if (provided === toolchain) use({});
      });
    },
  };
}

function deactivate() {
  runner.stopAll();
}

module.exports = { activate, deactivate };
