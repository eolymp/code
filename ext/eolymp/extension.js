const vscode = require('vscode');
const accounts = require('./account');
const judges = require('./judge');

async function activate(context) {
  const account = await accounts.create(context);
  const cp = await vscode.extensions.getExtension('eolymp.cp').activate();
  context.subscriptions.push(cp.registerJudge(judges.create(account)));
}

module.exports = { activate };
