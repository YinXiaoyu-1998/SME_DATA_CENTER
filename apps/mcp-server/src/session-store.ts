import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const employeeSessionSchema = z.object({
  apiUrl: z.string().url(),
  accessToken: z.string().min(1),
  createdAt: z.string().datetime(),
  employee: z.object({
    id: z.string().min(1),
    email: z.string().email(),
    role: z.string().min(1),
    disabled: z.boolean().optional(),
    labels: z.array(z.string())
  })
});

const sessionFileSchema = z.object({
  version: z.literal(1),
  defaultSessionName: z.string().min(1).optional(),
  sessions: z.record(z.string().min(1), employeeSessionSchema)
});

export type McpEmployeeSession = z.infer<typeof employeeSessionSchema>;
type McpSessionFile = z.infer<typeof sessionFileSchema>;

export class McpSessionRequiredError extends Error {
  constructor() {
    super("MCP session is required.");
  }
}

export class LocalMcpSessionStore {
  constructor(readonly filePath: string) {}

  async saveSession(sessionName: string, session: McpEmployeeSession): Promise<void> {
    const file = await this.readSessionFile();

    file.defaultSessionName = sessionName;
    file.sessions[sessionName] = session;

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(file, null, 2), {
      mode: 0o600
    });
  }

  async requireSession(sessionName?: string): Promise<McpEmployeeSession> {
    const file = await this.readSessionFile();
    const resolvedSessionName = sessionName ?? file.defaultSessionName;

    if (!resolvedSessionName) {
      throw new McpSessionRequiredError();
    }

    const session = file.sessions[resolvedSessionName];

    if (!session) {
      throw new McpSessionRequiredError();
    }

    return session;
  }

  private async readSessionFile(): Promise<McpSessionFile> {
    let raw: string;

    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return emptySessionFile();
        }
      }

      throw error;
    }

    return sessionFileSchema.parse(JSON.parse(raw));
  }
}

export function defaultSessionNameForEmail(email: string): string {
  return email.split("@")[0] ?? email;
}

function emptySessionFile(): McpSessionFile {
  return {
    version: 1,
    sessions: {}
  };
}
