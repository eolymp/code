const vscode = require('vscode');
const oauth = require('./oauth');

const ID = 'eolymp';
const KEY = 'profile';
const t = vscode.l10n.t;

function sessionOf(profile) {
  return { id: ID, accessToken: profile.session.access, account: { id: profile.user.id, label: profile.user.nickname || profile.user.name }, scopes: [] };
}

function page(title, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>`
    + '<body style="font: 16px system-ui, sans-serif; text-align: center; padding-top: 20vh; color-scheme: light dark">'
    + `<h1 style="font-size: 24px">${title}</h1><p>${text}</p>`;
}

async function create(context) {
  const changed = new vscode.EventEmitter();
  let renewing;

  const read = async () => {
    const kept = await context.secrets.get(KEY);
    return kept ? JSON.parse(kept) : undefined;
  };

  const renew = async (profile) => {
    try {
      const renewed = { ...profile, session: await oauth.refresh(profile.session) };
      await context.secrets.store(KEY, JSON.stringify(renewed));
      return renewed;
    } catch (err) {
      if (!(err instanceof oauth.Rejected)) return profile.session.expires > Date.now() ? profile : undefined;
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
      const latest = await read();
      if (latest && latest.session.refresh !== profile.session.refresh) return latest;
      await context.secrets.delete(KEY);
      return undefined;
    }
  };

  const current = async () => {
    const profile = await read();
    if (!profile || profile.session.expires - Date.now() > 60000) return profile;
    if (!renewing) renewing = renew(profile).finally(() => { renewing = undefined; });
    return renewing;
  };

  const first = await read();
  let known = first && sessionOf(first);
  const announce = async () => {
    const profile = await read();
    const now = profile && sessionOf(profile);
    const before = known;
    known = now;
    if (!before && !now) return;
    const same = now && before && now.account.id === before.account.id;
    changed.fire({
      added: now && !same ? [now] : [],
      removed: before && !same ? [before] : [],
      changed: same && now.accessToken !== before.accessToken ? [now] : [],
    });
  };

  const provider = {
    onDidChangeSessions: changed.event,
    async getSessions() {
      const profile = await current();
      return profile ? [sessionOf(profile)] : [];
    },
    createSession() {
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Continue signing in in your browser.'), cancellable: true }, async (_, cancel) => {
        const session = await oauth.signIn({
          open: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
          pages: {
            done: page(t('You are signed in'), t('You can close this page and return to Eolymp Code.')),
            failed: page(t('You are not signed in'), t('You can close this page and try again in Eolymp Code.')),
          },
          lang: vscode.env.language.slice(0, 2),
          cancelled: new Promise((resolve) => { cancel.onCancellationRequested(() => resolve(undefined)); }),
        });
        if (!session) throw new vscode.CancellationError();
        const info = await oauth.userinfo(session.access).catch(async (err) => {
          await oauth.revoke(session).catch(() => {});
          throw err;
        });
        const profile = { user: { id: info.sub, nickname: info.nickname, name: info.name }, session };
        await context.secrets.store(KEY, JSON.stringify(profile));
        return sessionOf(profile);
      });
    },
    async removeSession() {
      const profile = await read();
      if (!profile) return;
      await context.secrets.delete(KEY);
      try {
        await oauth.revoke(profile.session);
      } catch (err) {
        vscode.window.showWarningMessage(t('Could not end the session on Eolymp: {0}', err.message));
      }
    },
  };

  const offer = () => vscode.authentication.getSession(ID, [], { createIfNone: false }).then(undefined, () => {});
  const token = async () => {
    const session = await vscode.authentication.getSession(ID, [], { silent: true });
    return session && session.accessToken;
  };

  context.subscriptions.push(
    changed,
    context.secrets.onDidChange((e) => { if (e.key === KEY) announce(); }),
    vscode.authentication.registerAuthenticationProvider(ID, 'Eolymp', provider),
    vscode.authentication.onDidChangeSessions((e) => { if (e.provider.id === ID) offer(); }),
  );
  offer();

  return { token };
}

module.exports = { create };
