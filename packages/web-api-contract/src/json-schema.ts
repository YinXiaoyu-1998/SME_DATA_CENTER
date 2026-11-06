import { z } from "zod";

/**
 * 把 zod 编译成 JSON Schema（2020-12），去掉重复的 $schema 声明。
 * 只用 `io: "output"`：前端消费的是服务端实际发出的形状。
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: "output",
    unrepresentable: "any"
  }) as Record<string, unknown>;
  const result: Record<string, unknown> = { ...json };
  delete result["$schema"];
  return result;
}
