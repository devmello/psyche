# Connecting Google (Gmail, Calendar, Drive)

Psyche connects to Google through your own Google Cloud OAuth client. Your mail, calendar and files go straight from Google to your Gateway and never pass through anyone else's server. This guide covers creating the client once, giving its id to the Gateway, and what happens when you connect, reconnect or disconnect.

What the connector can do once it is connected, and the scopes each choice asks for, is in [connectors.md](connectors.md#google).

## What works on main

| Step | On main |
| --- | --- |
| Configure your OAuth client on the Gateway | Works: `config.json` or environment variables (below) |
| Start the sign-in, finish it in your browser, see the account and scopes | Works for clients of the Gateway API (`connectors.connect`, `connectors.list`, `connectors.updated`) |
| Connect button in onboarding and Settings → Connectors | Not wired yet. It comes with the desktop app's connect step (S11) |
| Stay connected across Gateway restarts | Works: connections are kept in the Gateway's database, tokens in the vault |
| Disconnect, which also revokes access at Google | Works (`connectors.disconnect`) |

The vault must be set up and unlocked when you connect or disconnect, because that is where the sign-in is stored.

## 1. Create your Google Cloud OAuth client

It takes a few minutes, once.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project. Any name works.
2. Under APIs & Services → Library, enable the **Gmail API**, the **Google Calendar API** and the **Google Drive API**.
3. Under Google Auth Platform → Branding, fill in the app name and your email, and set the audience to **External**.
4. Under Audience, click **Publish app** so the status is **In production**. If you leave it in Testing, Google expires the sign-in 7 days after you consent and you have to connect again. An app used only by its owner does not need Google's review. Google shows an "unverified app" screen when you consent; that is expected for your own client.
5. Under Data Access, you do not need to add scopes; Psyche asks for them at sign-in.
6. Under Clients, click **Create client** and choose the type **Desktop app**. Psyche signs in through a loopback address on your machine, which is what Desktop clients allow; a Web application client will not work.
7. Copy the **client ID** (it ends in `.apps.googleusercontent.com`) and the **client secret**.

The client ID is not a secret. The client secret is not very secret either for a Desktop client (Google treats it as public), but Psyche still keeps it in the vault and never in a file or the repository.

## 2. Give the client to the Gateway

Store the client secret in the vault, bound to Google's token endpoint so it can only ever be sent there. The command asks for the secret at a hidden prompt:

```bash
psyche vault add "Google OAuth client" --kind api_key --slug google-oauth-client --bind https://oauth2.googleapis.com
```

Then add the client to `$PSYCHE_HOME/config.json` (`~/.psyche/config.json` unless you set `PSYCHE_HOME`), next to any keys already there:

```json
{
  "connectors": {
    "google": {
      "clientId": "1234567890-abcdef.apps.googleusercontent.com",
      "clientSecret": "{{cred:google-oauth-client}}"
    }
  }
}
```

`clientSecret` only accepts a `{{cred:…}}` placeholder. The Gateway refuses to start if it finds the secret itself there, so a copied secret cannot end up in a config file or a backup of one.

Instead of `config.json` you can set the environment variables `PSYCHE_GOOGLE_CLIENT_ID` and `PSYCHE_GOOGLE_CLIENT_SECRET` (the placeholder, as above). They take precedence over `config.json`. With Docker Compose, put them in the Gateway service's `environment`.

Restart the Gateway. Google now shows as configured in the connector catalogue. Without a client id it shows as not configured, and connecting it is refused with a pointer to this guide.

## 3. Connect

You choose **Read only** or **Read and act** when you connect; [connectors.md](connectors.md#google) lists what each allows. Then:

1. The Gateway opens Google's consent page in your default browser. If it cannot open a browser (on a server), the link comes to you as a notification instead. The connector shows as signing in.
2. You sign in to Google and allow the access Psyche asks for. The first time, Psyche also asks you to approve reading the client secret from the vault; choose to allow it for this site so later token refreshes do not ask again.
3. Google sends your browser back to `http://127.0.0.1:<port>/callback` on the Gateway's machine. The Gateway checks the answer (PKCE, a one-time state), exchanges it for tokens and stores them in the vault as an item owned by the connector. It is listed among the vault's items as `<connector id> (OAuth)`.
4. The connector shows as connected, with your Google account and the scopes Google granted.

You have 5 minutes to finish. If you close the page or deny access, the connector shows an error and nothing is kept; connect again to retry.

If Google grants more than Psyche asked for (for example a leftover grant from another app on the same client), Psyche refuses the connection and asks you to remove its access in your Google account first.

### When the Gateway runs on another machine

The callback goes to `127.0.0.1` on the Gateway's machine, so the browser that finishes the sign-in must reach that address. When the Gateway runs on a server and your browser is on your laptop:

1. Start the connect. The consent link reaches you as a notification. Its `redirect_uri` parameter ends in `127.0.0.1:<port>/callback`; note the port.
2. Forward that port from your laptop to the server, for example:

   ```bash
   ssh -N -L 49152:127.0.0.1:49152 you@your-server
   ```

   with the port from the link in both places.
3. Open the link on your laptop and consent. The callback reaches the Gateway through the tunnel. Stop the tunnel afterwards.

## Reconnecting and changing the choice

Connecting again, for example to switch between Read only and Read and act, first revokes the previous grant at Google. A Read only connection therefore never keeps send or modify rights from an earlier one. Approvals and grants tied to the old connection stop working.

## Restarts

Connections are kept in the Gateway's database and the tokens in the vault. After a restart the connector comes back connected with its tools, without a new sign-in. If the vault is locked after the restart, the agent's Google tools fail with "the vault is locked" until you unlock it.

## Disconnecting

Disconnect revokes Psyche's access at Google, deletes the token item from the vault and removes the connector's tools. You can also remove access from your Google account (Security → Your connections to third-party apps); Psyche then shows the connector as needing a new sign-in the next time it uses it.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Google is not set up on this Gateway" | Add the client id (step 2) and restart the Gateway. |
| The Gateway does not start: "must be a `{{cred:slug}}` vault placeholder" | `clientSecret` or `PSYCHE_GOOGLE_CLIENT_SECRET` holds the secret itself. Store it with `psyche vault add` and use the placeholder. |
| Google says `redirect_uri_mismatch` | The client is not a Desktop app client. Create one (step 1.6). |
| Google says `access_denied` or "app not verified" with no way to continue | The app is in Testing and your account is not a test user, or the audience is Internal. Publish the app (step 1.4). |
| Connected, then a week later Google asks you to sign in again | The app is still in Testing. Publish it and connect again. |
| "the vault is locked" | Unlock it (`psyche vault unlock`) and try again. |
