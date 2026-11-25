const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const toolset = require('./tools');
const diagnostics = require('./diagnostics');
const update = require('./update');
const welcomePage = require('./welcome');

const standIn = process.platform === 'darwin' && !toolset.wanted() ? path.join(__dirname, 'include') : '';
let core;
let toolsRoot;
let managed;
let setup;
let terminalEnv;

function root() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders[0].uri.fsPath;
}

function adopt() {
  managed = toolset.installed(toolsRoot);
  const diagnose = () => setup.open();
  core.provide(managed ? { cxx: managed.cxx, python: managed.python, flags: managed.flags, env: managed.env, diagnose } : { include: standIn, diagnose });
  terminalEnv.clear();
  if (!managed && !standIn) return undefined;
  const updates = [];
  const flags = ['-std=c++17'];
  if (managed) {
    terminalEnv.prepend(process.platform === 'win32' ? 'Path' : 'PATH', [path.dirname(managed.cxx), path.dirname(managed.python)].join(path.delimiter) + path.delimiter);
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
  const saved = Promise.all(updates);
  if (updates.length) saved.then(() => vscode.commands.executeCommand('clangd.restart')).then(undefined, () => {});
  return saved.then(undefined, () => {});
}

const SAMPLES = {
  cpp: "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    int a, b;\n    cin >> a >> b;\n    cout << a + b << '\\n';\n    return 0;\n}\n",
  py: 'a = int(input())\nb = int(input())\nprint(a + b)\n',
};

function openPractice(context, language) {
  const practice = path.join(os.homedir(), 'Eolymp', 'practice');
  if (root()) {
    const sample = Object.keys(SAMPLES).map((lang) => path.join(practice, 'sum', `sum.${lang}`)).find((file) => fs.existsSync(file));
    if (!path.relative(root(), practice) && !context.globalState.get('welcomed') && sample) {
      context.globalState.update('welcomed', true);
      vscode.window.showTextDocument(vscode.Uri.file(sample));
    }
    return;
  }
  if (context.globalState.get('practice') || vscode.window.visibleTextEditors.length) return;
  context.globalState.update('practice', true);
  try {
    if (!fs.existsSync(practice)) {
      fs.mkdirSync(path.join(practice, 'sum'), { recursive: true });
      fs.writeFileSync(path.join(practice, 'sum', `sum.${language}`), SAMPLES[language]);
      fs.writeFileSync(path.join(practice, 'sum', '1.in'), '12\n9\n');
      fs.writeFileSync(path.join(practice, 'sum', '1.answer'), '21\n');
    }
    const style = path.join(path.dirname(practice), '.clang-format');
    if (!fs.existsSync(style)) fs.copyFileSync(path.join(__dirname, 'clang-format'), style);
  } catch {
    return;
  }
  vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(practice), { forceReuseWindow: true });
}

function activate(context) {
  core = vscode.extensions.getExtension('eolymp.eolymp-code').exports;
  const language = () => vscode.workspace.getConfiguration('eolympCode').get('language');
  const first = !vscode.workspace.workspaceFile && !root() && !context.globalState.get('practice') && !context.globalState.get('onboarded') && !vscode.window.visibleTextEditors.length;
  if (!vscode.workspace.workspaceFile && !first) openPractice(context, language());
  toolsRoot = path.join(context.globalStorageUri.fsPath, 'tools');
  fs.mkdirSync(toolsRoot, { recursive: true });
  terminalEnv = context.environmentVariableCollection;
  adopt();
  setup = diagnostics.create(context, toolsRoot, adopt);
  const welcome = welcomePage.create(context, setup, (chosen) => openPractice(context, chosen));
  if (first) welcome.show();
  else setup.start().catch(() => {});
  update.check(context).catch(() => {});
  context.subscriptions.push(
    vscode.commands.registerCommand('eolympCode.checkSetup', () => setup.open()),
    vscode.commands.registerCommand('eolympCode.welcome', () => welcome.show()),
    vscode.window.onDidChangeWindowState((window) => {
      const have = window.focused ? toolset.installed(toolsRoot) : undefined;
      if (have && (!managed || managed.dir !== have.dir)) adopt();
    }),
  );
  if (root()) vscode.commands.executeCommand('eolympCode.problems.focus');
}

module.exports = { activate };
