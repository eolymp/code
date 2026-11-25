const vscode = require('vscode');
const oauth = require('./oauth');

const SITE = 'eolymp.com';
const KEY = 'profiles';
const t = vscode.l10n.t;

const changed = new vscode.EventEmitter();
let secrets;
let known = [];

async function profiles() {
  return JSON.parse((await secrets.get(KEY)) || '[]');
}

async function keep(profile) {
  const rest = (await profiles()).filter((p) => p.site !== profile.site);
  await secrets.store(KEY, JSON.stringify(profile.session ? [...rest, profile] : rest));
}

async function fresh(profile) {
  if (profile.session.expires - Date.now() > 60000) return profile;
  try {
    const renewed = { ...profile, session: await oauth.refresh(profile.session) };
    await keep(renewed);
    return renewed;
  } catch (err) {
    if (!(err instanceof oauth.Rejected)) throw err;
    await keep({ site: profile.site });
    return undefined;
  }
}

function sessionOf(profile) {
  return { id: profile.site, accessToken: profile.session.access, account: { id: profile.user.id, label: profile.user.nickname || profile.user.name }, scopes: [] };
}

function page() {
  const title = t('You are signed in');
  const text = t('You can close this page and return to Eolymp Code.');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>`
    + '<body style="font: 16px system-ui, sans-serif; text-align: center; padding-top: 20vh; color-scheme: light dark">'
    + `<h1 style="font-size: 24px">${title}</h1><p>${text}</p>`;
}

const provider = {
  onDidChangeSessions: changed.event,
  async getSessions() {
    const live = await Promise.all((await profiles()).map(fresh));
    return live.filter(Boolean).map(sessionOf);
  },
  createSession() {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Continue signing in in your browser.'), cancellable: true }, async (_, cancel) => {
      const session = await oauth.signIn({
        open: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        page: page(),
        lang: vscode.env.language.slice(0, 2),
        cancelled: new Promise((resolve) => { cancel.onCancellationRequested(() => resolve(undefined)); }),
      });
      if (!session) throw new vscode.CancellationError();
      const info = await oauth.userinfo(session.access);
      const profile = { site: SITE, user: { id: info.sub, nickname: info.nickname, name: info.name, picture: info.picture }, session };
      await keep(profile);
      return sessionOf(profile);
    });
  },
  async removeSession(id) {
    const profile = (await profiles()).find((p) => p.site === id);
    if (!profile) return;
    await keep({ site: id });
    try {
      await oauth.revoke(profile.session);
    } catch (err) {
      vscode.window.showWarningMessage(t('Could not end the session on {0}: {1}', id, err.message));
    }
  },
};

async function announce() {
  const now = (await profiles()).map(sessionOf);
  const before = known;
  known = now;
  changed.fire({
    added: now.filter((s) => !before.some((b) => b.id === s.id)),
    removed: before.filter((b) => !now.some((s) => s.id === b.id)),
    changed: now.filter((s) => before.some((b) => b.id === s.id && b.accessToken !== s.accessToken)),
  });
}

async function register(context) {
  secrets = context.secrets;
  known = (await profiles()).map(sessionOf);
  context.subscriptions.push(
    changed,
    secrets.onDidChange((e) => { if (e.key === KEY) announce(); }),
    vscode.authentication.registerAuthenticationProvider('eolymp', 'Eolymp', provider),
  );
}

async function token(create) {
  const session = await vscode.authentication.getSession('eolymp', [], create ? { createIfNone: true } : { silent: true });
  return session && session.accessToken;
}

module.exports = { register, token };
