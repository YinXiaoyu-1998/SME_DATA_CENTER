# 企业资料中枢 Test Cases

This file tracks manual and automated acceptance scenarios as implementation criteria become tests.

## Phase 1 / Day 0 - Skeleton

| Case                  | Type            | Command / Evidence                                         | Expected Result                                                      | Status |
| --------------------- | --------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| Install dependencies  | Automated setup | `npm install`                                              | Creates `package-lock.json` and installs workspace dependencies.     | Pass   |
| Start local MySQL     | Local smoke     | `MYSQL_PORT=3307 docker compose up -d mysql`; health check | MySQL container starts and reports healthy or running.               | Pass   |
| Lint exists and runs  | Automated smoke | `npm run lint`                                             | Lint command exits successfully.                                     | Pass   |
| Typecheck runs        | Automated smoke | `npm run typecheck`                                        | TypeScript check exits successfully.                                 | Pass   |
| Test exists and runs  | Automated smoke | `npm test`                                                 | Vitest smoke test exits successfully.                                | Pass   |
| Tracking docs exist   | Manual review   | `ls docs/implementation/*.md`                              | Required long-term progress docs are present.                        | Pass   |
| Secrets not committed | Manual review   | `git status --short` and file review                       | `.env`, secrets, and real customer data are not staged or committed. | Pass   |
