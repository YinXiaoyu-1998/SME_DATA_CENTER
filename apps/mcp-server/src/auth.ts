import { z } from "zod";
import { EnterpriseHubApiError, type EnterpriseHubApiClient } from "./api-client.js";
import type { McpRuntimeConfig } from "./config.js";
import { apiErrorToolResult, jsonToolResult, type McpJsonToolResult } from "./tools.js";
import {
  defaultSessionNameForEmail,
  type LocalMcpSessionStore,
  type McpEmployeeSession
} from "./session-store.js";

const loginDevInputSchema = z.object({
  email: z.string().email(),
  sessionName: z.string().min(1).optional()
});

const devLoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  employee: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    role: z.string().min(1),
    disabled: z.boolean().optional(),
    labels: z.array(z.string())
  })
});

export interface LoginDevToolDependencies {
  apiClient: EnterpriseHubApiClient;
  config: Pick<McpRuntimeConfig, "apiUrl" | "profile">;
  sessionStore: LocalMcpSessionStore;
}

export async function loginDevTool(
  input: unknown,
  dependencies: LoginDevToolDependencies
): Promise<McpJsonToolResult> {
  const parsedInput = loginDevInputSchema.parse(input);

  try {
    const apiResponse = await dependencies.apiClient.requestJson({
      method: "POST",
      path: "/auth/dev-login",
      body: {
        email: parsedInput.email
      }
    });
    const loginResponse = devLoginResponseSchema.parse(apiResponse);
    const sessionName =
      parsedInput.sessionName ?? defaultSessionNameForEmail(loginResponse.employee.email);
    const session: McpEmployeeSession = {
      apiUrl: dependencies.config.apiUrl,
      accessToken: loginResponse.accessToken,
      createdAt: new Date().toISOString(),
      employee: loginResponse.employee
    };

    await dependencies.sessionStore.saveSession(sessionName, session);

    return jsonToolResult({
      employee: loginResponse.employee,
      sessionName,
      apiUrl: dependencies.config.apiUrl,
      profile: dependencies.config.profile
    });
  } catch (error) {
    if (error instanceof EnterpriseHubApiError) {
      return apiErrorToolResult(error.body);
    }

    throw error;
  }
}
