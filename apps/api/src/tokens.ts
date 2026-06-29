import { jwtVerify, SignJWT } from "jose";
import type { AuthenticatedEmployee } from "@enterprise-hub/domain";

export interface AccessTokenPayload {
  employeeId: string;
  email: string;
}

function secretKey(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

export async function signEmployeeAccessToken(
  employee: AuthenticatedEmployee,
  jwtSecret: string
): Promise<string> {
  return new SignJWT({ email: employee.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(employee.id)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secretKey(jwtSecret));
}

export async function verifyEmployeeAccessToken(
  accessToken: string,
  jwtSecret: string
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(accessToken, secretKey(jwtSecret));

  if (!payload.sub || typeof payload.email !== "string") {
    throw new Error("Token payload is missing employee identity.");
  }

  return {
    employeeId: payload.sub,
    email: payload.email
  };
}
