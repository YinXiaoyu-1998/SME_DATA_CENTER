import type { LauncherSelfCheck } from "./launcher.js";

type LogoutOutcome = {
  remoteRevocationConfirmed: boolean;
  localCredentialRemoved: boolean;
};

export function formatLauncherCommandResult(
  command: "self-check",
  result: LauncherSelfCheck
): string;
export function formatLauncherCommandResult(command: "logout", result: LogoutOutcome): string;
export function formatLauncherCommandResult(
  command: "self-check" | "logout",
  result: LauncherSelfCheck | LogoutOutcome
): string {
  void command;
  return `${JSON.stringify(result)}\n`;
}
