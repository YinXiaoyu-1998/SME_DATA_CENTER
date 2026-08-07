# Enterprise Hub (企业资料中枢)

A remote business-document service that employees use through their own AI agents. This context
covers the language for employee authentication, supported agent forms, and session ownership.

## Language

**Employee Account**:
The backend authorization subject (员工账号) that owns organization, role, labels, disabled state,
and audit attribution.
_Avoid_: account meaning a token, device, or agent installation.

**Login Identity**:
The verifier-owned credential identity bound to exactly one Employee Account.
_Avoid_: account, employee.

**Employee-owned agent**:
The general-purpose AI agent the employee talks to; it drives installation and use through the
Enterprise Hub MCP skill and must never see credentials.
_Avoid_: just "agent" when the speaker means the MCP host or the launcher.

**MCP client / host**:
The process environment that starts the launcher and exposes its tools to the agent.
_Avoid_: agent, launcher.

**Launcher**:
The stdio MCP adapter that owns protocol credentials and attaches them to remote requests; it never
exposes tokens or passwords to the agent/model.

**Employee channel**:
The surface through which the employee receives the login link from the agent (chat, phone remote
control, desktop UI).

**Agent instance**:
The launcher-bound, employee-visible identity of a login requester, shown on the verification page
and mirrored in the employee channel so the employee can confirm who receives the session.

**Verification page**:
The first-party Enterprise Hub page where the employee enters email/password and confirms the
Agent instance before the login completes.

**Secure store**:
The macOS Keychain or Windows Credential Manager record that holds the durable credential; absent
on headless hosts.

**Memory-only session**:
The no-durable-credential mode used when no Secure store exists; the session ends when the
launcher process exits and the employee taps the login link again.

**Support class A**:
Interactive desktop agent on macOS/Windows with a local system browser.

**Support class B**:
Phone-remote-controlled agent running on the employee's own PC.

**Support class C**:
Headless remote agent on a VPS/cloud host with no local browser or OS credential store.

**Support class D**:
Fully unattended agent with no interactive login; out of scope for login flows.

## Relationships

- An **Employee Account** is the authorization subject; a **Login Identity** binds to exactly one
  **Employee Account**.
- An **employee-owned agent** runs on an **MCP client / host**, which starts the **launcher**.
- The **launcher** authenticates on behalf of the **Employee Account** and never reveals
  credentials to the agent.
- The employee completes login through the **employee channel** on any device that can open a web
  page.

## Example dialogue

> **Dev:** "Support class C has no browser on the host — can the launcher still show the login
> link?"
> **Domain expert:** "Yes. The launcher returns the first-party link, the agent surfaces it through
> the employee channel, and the employee opens it on the phone."

## Flagged ambiguities

- "agent" was used to mean the AI agent, the MCP host, and the launcher — resolved: these are three
  distinct concepts.
- "支持某种 agent" conflated protocol-level compatibility with product-level support — resolved:
  product support requires an employee channel, a runnable launcher, and credential storage on the
  host.
- "账号" must never mean a token, device, or agent installation; it always means the
  **Employee Account**.
