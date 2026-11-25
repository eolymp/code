const vscode = require('vscode');
const accounts = require('./account');
const judges = require('./judge');

async function activate(context) {
  const account = await accounts.create(context);
  const core = await vscode.extensions.getExtension('eolymp.eolymp-code').activate();
  context.subscriptions.push(core.registerJudge(judges.create(account)));
}

module.exports = { activate };
