import { z } from "zod";

/**
 * 把 zod 编译成 JSON Schema（2020-12），去掉重复的 $schema 声明。
 * 只用 `io: "output"`：前端消费的是服务端实际发出的形状。
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    io: "output",
    // 复用同一子 schema 时输出 $ref/$defs，而不是整棵树重复内联。
    // 工作流响应有大量共享结构，不加这个选项契约会膨胀数倍。
    reused: "ref",
    unrepresentable: "any"
  }) as Record<string, unknown>;
  const result: Record<string, unknown> = { ...json };
  delete result["$schema"];
  return result;
}
