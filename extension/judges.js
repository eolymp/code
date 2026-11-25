const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const ws = require('./workspace');

const t = vscode.l10n.t;

function create(createProblem, refresh) {
  const judges = new Map();

  const register = (judge) => {
    judges.set(judge.id, judge);
    vscode.commands.executeCommand('setContext', 'eolympCode.hasJudges', true);
    return new vscode.Disposable(() => {
      judges.delete(judge.id);
      vscode.commands.executeCommand('setContext', 'eolympCode.hasJudges', judges.size > 0);
    });
  };

  const open = async (judge, found) => {
    try {
      const problem = await judge.load(found.id);
      const dir = await createProblem(problem.name, problem.templates);
      if (!dir) return;
      problem.tests.forEach((test, index) => {
        const input = path.join(dir, `${index + 1}.in`);
        if (fs.existsSync(input)) return;
        fs.writeFileSync(input, test.input);
        fs.writeFileSync(path.join(dir, `${index + 1}.answer`), test.answer);
      });
      fs.writeFileSync(path.join(dir, ws.LINK), `${JSON.stringify({ judge: judge.id, ...problem.link }, null, 2)}\n`);
      refresh();
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

  return { register, find };
}

module.exports = { create };
