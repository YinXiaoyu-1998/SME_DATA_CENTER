import { z } from "zod";

/** 网页会话里可安全下发给浏览器的员工身份。禁用标记与凭据指纹永不出现在这里。 */
export const webSessionIdentitySchema = z
  .object({
    employeeId: z.string().min(1),
    displayName: z.string().min(1),
    email: z.string().min(1),
    orgId: z.string().min(1),
    organizationName: z.string().min(1),
    role: z.enum(["admin", "employee"]),
    clearance: z.number().int().min(0).max(3)
  })
  .strict();

export type WebSessionIdentity = z.output<typeof webSessionIdentitySchema>;

/** `GET /session`、`POST /session` 与登录成功的统一响应。 */
export const webSessionResponseSchema = z
  .object({
    identity: webSessionIdentitySchema,
    /** 写操作必须回传的 CSRF 令牌，由当前会话密钥派生；换会话即失效。 */
    csrfToken: z.string().min(1),
    /** 导航与路由守卫只依据这个服务端判定，不在前端重算角色。 */
    canManageSettings: z.boolean()
  })
  .strict();

export type WebSessionResponse = z.output<typeof webSessionResponseSchema>;

export const webSessionLoginBodySchema = z
  .object({
    email: z.string().min(1).max(320),
    password: z.string().min(1)
  })
  .strict();

export type WebSessionLoginBody = z.output<typeof webSessionLoginBodySchema>;

export const webSessionLogoutResponseSchema = z.object({ signedOut: z.literal(true) }).strict();
