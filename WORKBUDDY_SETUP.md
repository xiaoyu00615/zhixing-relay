# WorkBuddy setup

V0.1 needs these scopes for the local assistant:

```text
user.localassistant.readable
user.localassistant.invokable
```

Relay uses the Local Assistant APIs for:

- online status
- sending a text message
- incremental message history

## Token handling

Minimum:

```env
WORKBUDDY_ACCESS_TOKEN=...
```

Optional automatic refresh:

```env
WORKBUDDY_REFRESH_TOKEN=...
WORKBUDDY_CLIENT_ID=...
WORKBUDDY_CLIENT_SECRET=...
```

Never place `WORKBUDDY_CLIENT_SECRET` in Chrome extension files.

## permission_response

V0.1 deliberately does not automate `permission_response`.

At the time this project was generated, WorkBuddy's Chinese Open API page described
`permission_response`, while the English page stated that only `text` was accepted and
tool approval remains with the local user.

Until the behavior is verified against the user's actual WorkBuddy build/account,
automatic approvals stay disabled.
