"use client";

import { createAuthClient } from "better-auth/react";

// 同じオリジンの /api/auth を使う
export const authClient = createAuthClient();
