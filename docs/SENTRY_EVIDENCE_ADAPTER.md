# Sentry evidence adapter

The Sentry adapter verifies that an exact reviewed organization, project,
environment and expected release can be observed. It returns bounded monitoring
and deployment evidence to the existing evidence runner; it never writes the
catalog.

The adapter makes fixed `GET` requests to the official project, releases and
issues endpoints. It retains only an unresolved-issue count, the newest issue
timestamp, an exact reviewed release match and a safe Sentry console URL. Event
payloads, titles, stack traces, breadcrumbs, user data, raw logs, release commit
content and provider error bodies are discarded.

An empty issue result means only that the bounded Sentry query returned no
unresolved issues. It is not proof that the application is healthy. A release
mismatch leaves deployment evidence `unknown`; it does not rewrite the reviewed
revision.

## Reviewed identity

```json
{
  "organizationSlug": "example-team",
  "projectSlug": "pocket-ops",
  "environment": "production",
  "expectedRelease": "pocket-ops@1.4.0",
  "lookbackHours": 24
}
```

The credential remains an external environment or secret-manager reference.
The adapter requires only the read scopes needed for project, release and issue
metadata. DevHub never stores or returns its value.

Official API references:

- [List an organization's projects](https://docs.sentry.io/api/organizations/list-an-organizations-projects/)
- [List a project's releases](https://docs.sentry.io/api/releases/list-a-projects-releases/)
- [List a project's issues](https://docs.sentry.io/api/events/list-a-projects-issues/)
