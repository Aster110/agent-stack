# Operations

Use the repository [deployment SOP](../../../docs/DEPLOYMENT-SOP.md) and [release policy](../../../docs/RELEASE-POLICY.md). Legacy `codex-seat` commands expose `status --seat NAME`; new roles use agent-runtime.

Back up private state before a migration. Confirm actual process entrypoint and build version, preserve the existing thread, and verify task/result delivery after restart. A process or relay receipt alone is not acceptance.
