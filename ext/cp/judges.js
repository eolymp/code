const vscode = require('vscode');
const path = require('path');
const ws = require('./workspace');
const submission = require('./submission');

const t = vscode.l10n.t;

function declared() {
  return vscode.extensions.all.filter((extension) => extension.packageJSON.cp && extension.packageJSON.cp.contests);
}

function create(createProblem, refresh) {
  const judges = new Map();
  const registered = new vscode.EventEmitter();

  const linkOf = (document) => {
    const link = document.uri.scheme === 'file' && ws.langOf(document.fileName) ? ws.linkOf(path.dirname(document.fileName)) : undefined;
    const judge = link && judges.get(link.judge);
    return judge && judge.submit && judge.watch ? link : undefined;
  };

  const mark = () => {
    const editor = vscode.window.activeTextEditor;
    vscode.commands.executeCommand('setContext', 'cp.linked', Boolean(editor && linkOf(editor.document)));
  };

  const announce = () => {
    vscode.commands.executeCommand('setContext', 'cp.hasJudges', judges.size > 0);
    mark();
  };

  const register = (judge) => {
    judges.set(judge.id, judge);
    announce();
    registered.fire(judge);
    return new vscode.Disposable(() => {
      judges.delete(judge.id);
      announce();
    });
  };

  const submit = async () => {
    const editor = vscode.window.activeTextEditor;
    const link = editor && linkOf(editor.document);
    if (!link) return;
    const file = editor.document.fileName;
    const judge = judges.get(link.judge);
    const problem = { id: link.id, url: link.url, contest: link.contest };
    let id;
    try {
      id = await judge.submit(problem, { language: ws.langOf(file), source: editor.document.getText() });
    } catch (err) {
      if (!(err instanceof vscode.CancellationError)) vscode.window.showErrorMessage(t('Could not submit {0}: {1}', path.basename(file), err.message));
    }
    if (!id) return;
    try {
      await submission.watch(judge, problem, id, file);
    } catch (err) {
      vscode.window.showErrorMessage(t('{0} is submitted, but its testing could not be followed: {1}', path.basename(file), err.message));
    }
  };

  const open = async (judge, found) => {
    try {
      const problem = await judge.load(found.id);
      const dir = await createProblem(problem.name, problem.templates);
      if (!dir) return;
      ws.saveExamples(dir, problem.tests);
      ws.saveLink(path.join(dir, ws.LINK), { judge: judge.id, id: String(found.id), url: problem.url });
      refresh();
      mark();
    } catch (err) {
      vscode.window.showErrorMessage(t('Could not open the problem: {0}', err.message));
    }
  };

  const find = async () => {
    if (!vscode.workspace.workspaceFolders) {
      vscode.window.showErrorMessage(t('Open a folder first: problems are created in it.'));
      return;
    }
    const all = [...judges.values()];
    const chosen = all.length > 1 ? await vscode.window.showQuickPick(all.map((judge) => ({ label: judge.label, judge })), { placeHolder: t('Where to look for a problem') }) : { judge: all[0] };
    const judge = chosen && chosen.judge;
    if (!judge) return;
    const box = vscode.window.createQuickPick();
    let asked = 0;
    let timer;
    const look = () => {
      asked += 1;
      const mine = asked;
      box.busy = true;
      judge.search(box.value).then((found) => {
        if (mine !== asked) return;
        box.title = undefined;
        box.items = found.map((problem) => ({ label: problem.label, description: problem.description, alwaysShow: true, problem }));
        box.busy = false;
      }, (err) => {
        if (mine !== asked) return;
        box.title = t('Could not search: {0}', err.message);
        box.items = [];
        box.busy = false;
      });
    };
    box.placeholder = t('Search problems on {0}', judge.label);
    box.onDidChangeValue(() => {
      box.busy = true;
      clearTimeout(timer);
      timer = setTimeout(look, 250);
    });
    box.onDidAccept(() => {
      const picked = box.selectedItems[0];
      if (!picked || box.busy) return;
      box.hide();
      open(judge, picked.problem);
    });
    box.onDidHide(() => {
      clearTimeout(timer);
      asked += 1;
      box.dispose();
    });
    box.show();
    look();
  };

  return { register, find, submit, mark, declared, onDidRegister: registered.event, all: () => [...judges.values()], get: (id) => judges.get(id) };
}

module.exports = { create };
