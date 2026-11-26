const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function page(webview, file, values = {}) {
  const asset = (name) => String(webview.asWebviewUri(vscode.Uri.file(path.join(__dirname, name))));
  const fields = {
    nonce: crypto.randomBytes(16).toString('base64'),
    source: webview.cspSource,
    lang: vscode.env.language,
    font: asset('codicon.ttf'),
    tones: asset('tones.css'),
    ...values,
  };
  return fs.readFileSync(path.join(__dirname, file), 'utf8').replace(/{{(\w+)}}/g, (match, key) => (key in fields ? fields[key] : match));
}

module.exports = { page };
