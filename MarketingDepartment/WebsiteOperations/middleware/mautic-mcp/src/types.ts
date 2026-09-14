/** POST /oauth/v2/token のレスポンス */
export interface MauticTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/** Mautic API のエラーレスポンス */
export interface MauticErrorBody {
  errors?: { message: string; code: number; type: string | null }[];
}

export interface MauticContact {
  id: number;
  dateAdded: string | null;
  dateModified: string | null;
  lastActive: string | null;
  points: number;
  owner: { id: number; firstName: string; lastName: string } | null;
  stage: { id: number; name: string } | null;
  tags: { tag: string }[];
  doNotContact?: { channel: string; reason: number; comments: string | null }[];
  fields: { all: Record<string, unknown> };
}

export interface MauticContactListResponse {
  total: number | string;
  // 該当 0 件の場合、Mautic は {} ではなく [] を返す
  contacts: Record<string, MauticContact> | MauticContact[];
}

export interface MauticContactResponse {
  contact: MauticContact;
}
