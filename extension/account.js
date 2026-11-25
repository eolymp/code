const vscode = require('vscode');
const oauth = require('./oauth');

const SITE = 'eolymp.com';
const KEY = 'profiles';
const t = vscode.l10n.t;

let secrets;
let bar;
let busy = false;

async function profiles() {
  return JSON.parse((await secrets.get(KEY)) || '[]');
}

async function keep(profile) {
  const rest = (await profiles()).filter((p) => p.site !== profile.site);
  await secrets.store(KEY, JSON.stringify(profile.session ? [...rest, profile] : rest));
}

async function token(site = SITE) {
  const profile = (await profiles()).find((p) => p.site === site);
  if (!profile) return undefined;
  if (profile.session.expires - Date.now() > 60000) return profile.session.access;
  try {
    const session = await oauth.refresh(profile.session);
    await keep({ ...profile, session });
    return session.access;
  } catch (err) {
    if (!(err instanceof oauth.Rejected)) throw err;
    await keep({ site });
    return undefined;
  }
}

async function render() {
  const profile = (await profiles()).find((p) => p.site === SITE);
  vscode.commands.executeCommand('setContext', 'eolympCode.signedIn', Boolean(profile));
  bar.text = `$(account) ${profile ? profile.user.nickname || profile.user.name : t('Sign In')}`;
  bar.tooltip = profile ? t('Signed in to {0} as {1}', SITE, profile.user.nickname || profile.user.name) : t('Sign in to {0}', SITE);
  bar.command = profile ? 'eolympCode.account' : 'eolympCode.signIn';
  bar.show();
}

function page() {
  const title = t('You are signed in');
  const text = t('You can close this page and return to Eolymp Code.');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>`
    + '<body style="font: 16px system-ui, sans-serif; text-align: center; padding-top: 20vh; color-scheme: light dark">'
    + `<h1 style="font-size: 24px">${title}</h1><p>${text}</p>`;
}

async function signIn() {
  if (busy) return;
  busy = true;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Continue signing in in your browser.'), cancellable: true }, async (_, cancel) => {
      const session = await oauth.signIn({
        open: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        page: page(),
        lang: vscode.env.language.slice(0, 2),
        cancelled: new Promise((resolve) => { cancel.onCancellationRequested(() => resolve(undefined)); }),
      });
      if (!session) return;
      const info = await oauth.userinfo(session.access);
      await keep({ site: SITE, user: { id: info.sub, nickname: info.nickname, name: info.name, picture: info.picture }, session });
    });
  } catch (err) {
    vscode.window.showErrorMessage(t('Could not sign in: {0}', err.message));
  } finally {
    busy = false;
  }
}

async function signOut() {
  await keep({ site: SITE });
}

async function account() {
  const picked = await vscode.window.showQuickPick([{ label: `$(sign-out) ${t('Sign Out')}` }], { placeHolder: bar.tooltip });
  if (picked) await signOut();
}

function register(context) {
  secrets = context.secrets;
  bar = vscode.window.createStatusBarItem('eolympCode.account', vscode.StatusBarAlignment.Left, 40);
  bar.name = t('Eolymp Account');
  context.subscriptions.push(
    bar,
    secrets.onDidChange((e) => { if (e.key === KEY) render(); }),
    vscode.commands.registerCommand('eolympCode.signIn', signIn),
    vscode.commands.registerCommand('eolympCode.signOut', signOut),
    vscode.commands.registerCommand('eolympCode.account', account),
  );
  render();
  token().catch(() => {});
}

module.exports = { register, token };
